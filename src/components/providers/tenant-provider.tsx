"use client";

import { createContext, useContext, ReactNode } from "react";

interface TenantUserContext {
  id: string;
  fullName: string;
  email: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: string;
  permissions: string[];
}

const TenantContext = createContext<TenantUserContext | null>(null);

export function TenantProvider({
  tenantUser,
  children,
}: {
  tenantUser: TenantUserContext;
  children: ReactNode;
}) {
  return (
    <TenantContext.Provider value={tenantUser}>
      {children}
    </TenantContext.Provider>
  );
}

export function useTenantUser() {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error("useTenantUser must be used within a TenantProvider");
  }
  return context;
}
