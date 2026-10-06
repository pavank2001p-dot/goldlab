"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { api, type User } from "./api";

// user: undefined = still checking, null = signed out
type Ctx = { user: User | null | undefined; setUser: (u: User | null) => void };
const UserContext = createContext<Ctx>({ user: undefined, setUser: () => {} });

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
  }, []);
  return <UserContext.Provider value={{ user, setUser }}>{children}</UserContext.Provider>;
}

export const useUser = () => useContext(UserContext);
