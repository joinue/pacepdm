import { AdminGate } from "../admin-gate";
import { PERMISSIONS } from "@/lib/permissions";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <AdminGate permission={PERMISSIONS.ADMIN_SETTINGS}>{children}</AdminGate>;
}
