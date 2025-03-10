/** @file The React provider for localStorage, along with hooks to use the provider
 * via the shared React context. */
import * as React from 'react'

import LocalStorage from '#/utilities/LocalStorage'

// ===========================
// === LocalStorageContext ===
// ===========================

/** State contained in a `LocalStorageContext`. */
export interface LocalStorageContextType {
  readonly localStorage: LocalStorage
}

// @ts-expect-error The default value will never be exposed, as using this without a `Provider`
// is a mistake.
const LocalStorageContext = React.createContext<LocalStorageContextType>(null)

/** Props for a {@link LocalStorageProvider}. */
export interface LocalStorageProviderProps extends Readonly<React.PropsWithChildren> {}

// ============================
// === LocalStorageProvider ===
// ============================

/** A React Provider that lets components get the shortcut registry. */
export default function LocalStorageProvider(props: LocalStorageProviderProps) {
  const { children } = props
  const localStorage = React.useMemo(() => new LocalStorage(), [])

  return (
    <LocalStorageContext.Provider value={{ localStorage }}>{children}</LocalStorageContext.Provider>
  )
}

/** Exposes a property to get the shortcut registry. */
export function useLocalStorage() {
  return React.useContext(LocalStorageContext)
}
