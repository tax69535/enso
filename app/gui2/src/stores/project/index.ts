import { injectGuiConfig, type GuiConfig } from '@/providers/guiConfig'
import { Awareness } from '@/stores/awareness'
import { ComputedValueRegistry } from '@/stores/project/computedValueRegistry'
import {
  ExecutionContext,
  type NodeVisualizationConfiguration,
} from '@/stores/project/executionContext'
import { VisualizationDataRegistry } from '@/stores/project/visualizationDataRegistry'
import { attachProvider, useObserveYjs } from '@/util/crdt'
import { nextEvent } from '@/util/data/observable'
import { type Opt } from '@/util/data/opt'
import { Err, Ok, type Result } from '@/util/data/result'
import { ReactiveMapping } from '@/util/database/reactiveDb'
import { createDataWebsocket, createRpcTransport, useAbortScope } from '@/util/net'
import { DataServer } from '@/util/net/dataServer'
import { tryQualifiedName } from '@/util/qualifiedName'
import { computedAsync } from '@vueuse/core'
import * as random from 'lib0/random'
import { defineStore } from 'pinia'
import { OutboundPayload, VisualizationUpdate } from 'shared/binaryProtocol'
import { LanguageServer } from 'shared/languageServer'
import type { Diagnostic, ExpressionId, MethodPointer } from 'shared/languageServerTypes'
import { type AbortScope } from 'shared/util/net'
import {
  DistributedProject,
  localUserActionOrigins,
  type ExternalId,
  type Uuid,
} from 'shared/yjsModel'
import {
  computed,
  markRaw,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
  watchEffect,
  type WatchSource,
  type WritableComputedRef,
} from 'vue'
import * as Y from 'yjs'

interface LsUrls {
  rpcUrl: string
  dataUrl: string
}

function resolveLsUrl(config: GuiConfig): LsUrls {
  const engine = config.engine
  if (engine == null) throw new Error('Missing engine configuration')
  if (engine.rpcUrl != null && engine.dataUrl != null) {
    return {
      rpcUrl: engine.rpcUrl,
      dataUrl: engine.dataUrl,
    }
  }
  throw new Error('Incomplete engine configuration')
}

function createLsRpcConnection(clientId: Uuid, url: string, abort: AbortScope): LanguageServer {
  const transport = createRpcTransport(url)
  const connection = new LanguageServer(clientId, transport)
  abort.onAbort(() => connection.release())
  return connection
}

function initializeDataConnection(clientId: Uuid, url: string, abort: AbortScope) {
  const client = createDataWebsocket(url, 'arraybuffer')
  const connection = new DataServer(clientId, client, abort)
  abort.handleDispose(connection)
  onScopeDispose(() => connection.dispose())
  return connection
}

/**
 * The project store synchronizes and holds the open project-related data. The synchronization is
 * performed using a CRDT data types from Yjs. Once the data is synchronized with a "LS bridge"
 * client, it is submitted to the language server as a document update.
 */
export const useProjectStore = defineStore('project', () => {
  const abort = useAbortScope()

  const observedFileName = ref<string>()

  const doc = new Y.Doc()
  const awareness = new Awareness(doc)

  const config = injectGuiConfig()
  const projectName = config.value.startup?.project
  if (projectName == null) throw new Error('Missing project name.')
  const projectDisplayName = config.value.startup?.displayedProjectName ?? projectName

  const clientId = random.uuidv4() as Uuid
  const lsUrls = resolveLsUrl(config.value)
  const lsRpcConnection = createLsRpcConnection(clientId, lsUrls.rpcUrl, abort)
  const contentRoots = lsRpcConnection.contentRoots

  const dataConnection = initializeDataConnection(clientId, lsUrls.dataUrl, abort)
  const rpcUrl = new URL(lsUrls.rpcUrl)
  const isOnLocalBackend =
    rpcUrl.protocol === 'mock:' ||
    rpcUrl.hostname === 'localhost' ||
    rpcUrl.hostname === '127.0.0.1' ||
    rpcUrl.hostname === '[::1]' ||
    rpcUrl.hostname === '0:0:0:0:0:0:0:1'

  const name = computed(() => config.value.startup?.project)
  const namespace = computed(() => config.value.engine?.namespace)
  const fullName = computed(() => {
    const ns = namespace.value
    if (import.meta.env.PROD && ns == null) {
      console.warn(
        'Unknown project\'s namespace. Assuming "local", however it likely won\'t work in cloud',
      )
    }
    const projectName = name.value
    if (projectName == null) {
      console.error(
        "Unknown project's name. Cannot specify opened module's qualified path; many things may not work",
      )
      return null
    }
    return `${ns ?? 'local'}.${projectName}`
  })
  const modulePath = computed(() => {
    const filePath = observedFileName.value
    if (filePath == null) return undefined
    const withoutFileExt = filePath.replace(/\.enso$/, '')
    const withDotSeparators = withoutFileExt.replace(/\//g, '.')
    return tryQualifiedName(`${fullName.value}.${withDotSeparators}`)
  })

  let yDocsProvider: ReturnType<typeof attachProvider> | undefined
  watchEffect((onCleanup) => {
    // For now, let's assume that the websocket server is running on the same host as the web server.
    // Eventually, we can make this configurable, or even runtime variable.
    const socketUrl = new URL(location.origin)
    socketUrl.protocol = location.protocol.replace(/^http/, 'ws')
    socketUrl.pathname = '/project'
    yDocsProvider = attachProvider(
      socketUrl.href,
      'index',
      { ls: lsUrls.rpcUrl },
      doc,
      awareness.internal,
    )
    onCleanup(disposeYDocsProvider)
  })

  const projectModel = new DistributedProject(doc)
  const moduleDocGuid = ref<string>()

  function currentDocGuid() {
    const name = observedFileName.value
    if (name == null) return
    return projectModel.modules.get(name)?.guid
  }
  function tryReadDocGuid() {
    const guid = currentDocGuid()
    if (guid === moduleDocGuid.value) return
    moduleDocGuid.value = guid
  }

  projectModel.modules.observe(tryReadDocGuid)
  watchEffect(tryReadDocGuid)

  const module = computedAsync(async () => {
    const guid = moduleDocGuid.value
    if (guid == null) return null
    const moduleName = projectModel.findModuleByDocId(guid)
    if (moduleName == null) return null
    const mod = await projectModel.openModule(moduleName)
    for (const origin of localUserActionOrigins) mod?.undoManager.addTrackedOrigin(origin)
    return mod
  })

  const entryPoint = computed<MethodPointer>(() => {
    const projectName = fullName.value
    const mainModule = `${projectName}.Main`
    return { module: mainModule, definedOnType: mainModule, name: 'main' }
  })

  function createExecutionContextForMain(): ExecutionContext {
    return new ExecutionContext(
      lsRpcConnection,
      {
        methodPointer: entryPoint.value,
        positionalArgumentsExpressions: [],
      },
      abort,
    )
  }

  const firstExecution = nextEvent(lsRpcConnection, 'executionContext/executionComplete').catch(
    (error) => {
      console.error('First execution failed:', error)
      throw error
    },
  )
  const executionContext = createExecutionContextForMain()
  const visualizationDataRegistry = new VisualizationDataRegistry(executionContext, dataConnection)
  const computedValueRegistry = ComputedValueRegistry.WithExecutionContext(executionContext)

  const diagnostics = shallowRef<Diagnostic[]>([])
  executionContext.on('executionStatus', (newDiagnostics) => {
    diagnostics.value = newDiagnostics
  })

  function useVisualizationData(configuration: WatchSource<Opt<NodeVisualizationConfiguration>>) {
    const id = random.uuidv4() as Uuid

    watch(
      configuration,
      (config, _, onCleanup) => {
        executionContext.setVisualization(id, config)
        onCleanup(() => executionContext.setVisualization(id, null))
      },
      // Make sure to flush this watch in 'post', otherwise it might cause operations on stale
      // ASTs just before the widget tree renders and cleans up the associated widget instances.
      { immediate: true, flush: 'post' },
    )

    return computed(() => parseVisualizationData(visualizationDataRegistry.getRawData(id)))
  }

  const dataflowErrors = new ReactiveMapping(computedValueRegistry.db, (id, info) => {
    const config = computed(() =>
      info.payload.type === 'DataflowError' ?
        {
          expressionId: id,
          visualizationModule: 'Standard.Visualization.Preprocessor',
          expression: {
            module: 'Standard.Visualization.Preprocessor',
            definedOnType: 'Standard.Visualization.Preprocessor',
            name: 'error_preprocessor',
          },
        }
      : null,
    )
    const data = useVisualizationData(config)
    return computed<{ kind: 'Dataflow'; message: string } | undefined>(() => {
      const visResult = data.value
      if (!visResult) return
      if (!visResult.ok) {
        visResult.error.log('Dataflow Error visualization evaluation failed')
        return undefined
      } else if ('message' in visResult.value && typeof visResult.value.message === 'string') {
        if ('kind' in visResult.value && visResult.value.kind === 'Dataflow')
          return { kind: visResult.value.kind, message: visResult.value.message }
        // Other kinds of error are not handled here
        else return undefined
      } else {
        console.error('Invalid dataflow error payload:', visResult.value)
        return undefined
      }
    })
  })

  const isRecordingEnabled = computed(() => executionMode.value === 'live')

  function stopCapturingUndo() {
    module.value?.undoManager.stopCapturing()
  }

  function executeExpression(
    expressionId: ExternalId,
    expression: string,
  ): Promise<Result<any> | null> {
    return new Promise((resolve) => {
      const visualizationId = random.uuidv4() as Uuid
      const dataHandler = (visData: VisualizationUpdate, uuid: Uuid | null) => {
        if (uuid === visualizationId) {
          dataConnection.off(`${OutboundPayload.VISUALIZATION_UPDATE}`, dataHandler)
          executionContext.off('visualizationEvaluationFailed', errorHandler)
          const dataStr = Ok(visData.dataString())
          resolve(parseVisualizationData(dataStr))
        }
      }
      const errorHandler = (
        uuid: Uuid,
        _expressionId: ExpressionId,
        message: string,
        _diagnostic: Diagnostic | undefined,
      ) => {
        if (uuid == visualizationId) {
          resolve(Err(message))
          dataConnection.off(`${OutboundPayload.VISUALIZATION_UPDATE}`, dataHandler)
          executionContext.off('visualizationEvaluationFailed', errorHandler)
        }
      }
      dataConnection.on(`${OutboundPayload.VISUALIZATION_UPDATE}`, dataHandler)
      executionContext.on('visualizationEvaluationFailed', errorHandler)
      return lsRpcConnection.executeExpression(
        executionContext.id,
        visualizationId,
        expressionId,
        expression,
      )
    })
  }

  function parseVisualizationData(data: Result<string | null> | null): Result<any> | null {
    if (!data?.ok) return data
    if (data.value == null) return null
    try {
      return Ok(markRaw(JSON.parse(data.value)))
    } catch (error) {
      if (error instanceof SyntaxError)
        return Err(`Parsing visualization result failed: ${error.message}`)
      else throw error
    }
  }

  const { executionMode } = setupSettings(projectModel)

  function disposeYDocsProvider() {
    yDocsProvider?.dispose()
    yDocsProvider = undefined
  }

  const recordMode = computed({
    get() {
      return executionMode.value === 'live'
    },
    set(value) {
      executionMode.value = value ? 'live' : 'design'
    },
  })

  return {
    setObservedFileName(name: string) {
      observedFileName.value = name
    },
    get observedFileName() {
      return observedFileName.value
    },
    name: projectName,
    displayName: projectDisplayName,
    isOnLocalBackend,
    executionContext,
    firstExecution,
    diagnostics,
    module,
    modulePath,
    entryPoint,
    projectModel,
    contentRoots,
    awareness: markRaw(awareness),
    computedValueRegistry: markRaw(computedValueRegistry),
    lsRpcConnection: markRaw(lsRpcConnection),
    dataConnection: markRaw(dataConnection),
    useVisualizationData,
    isRecordingEnabled,
    stopCapturingUndo,
    executionMode,
    recordMode,
    dataflowErrors,
    executeExpression,
    disposeYDocsProvider,
  }
})

type ExecutionMode = 'live' | 'design'
type Settings = { executionMode: WritableComputedRef<ExecutionMode> }
function setupSettings(project: DistributedProject | null): Settings {
  const settings = computed(() => project?.settings)
  // Value synchronized with a key of the `settings` map, used to enforce reactive dependencies.
  const executionMode_ = ref<ExecutionMode>()
  const executionMode = computed<ExecutionMode>({
    get() {
      return executionMode_.value ?? 'design'
    },
    set(value) {
      // Update the synchronized map; the change observer will set `executionMode_`.
      if (settings.value != null) settings.value.set('executionMode', value)
    },
  })
  useObserveYjs(settings, (event) => {
    event.changes.keys.forEach((change, key) => {
      if (key == 'executionMode') {
        if (change.action === 'add' || change.action === 'update') {
          switch (settings.value?.get('executionMode')) {
            case 'design':
              executionMode_.value = 'design'
              break
            case 'live':
              executionMode_.value = 'live'
              break
            default:
              console.log(`Bug: Unexpected executionMode. Ignoring...`, executionMode)
              break
          }
        } else if (change.action === 'delete') {
          executionMode_.value = undefined
        }
      }
    })
  })
  return { executionMode }
}
