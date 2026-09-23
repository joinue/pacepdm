import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getServiceClient } from "@/lib/db";
import { OnboardingClient } from "./onboarding-client";

/**
 * Where a signed-in user with no active workspace lands.
 *
 * Two very different people arrive here: someone who just confirmed their
 * sign-up and is about to get a workspace, and someone whose membership was
 * deactivated or removed. The page used to show both the "Set up your
 * workspace" form — a deactivated engineer was invited to found a company.
 * The memberships are read here, on the server, so the client form only
 * renders for the person it is for.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ create?: string }>;
}) {
  const user = await getSession();
  if (!user) redirect("/login");

  const db = getServiceClient();
  const { data: memberships } = await db
    .from("tenant_users")
    .select("id, isActive, tenant:tenants(name)")
    .eq("authUserId", user.id);

  if (memberships?.some((m) => m.isActive)) redirect("/");

  const { create } = await searchParams;
  const deactivatedFrom = (memberships ?? [])
    .filter((m) => !m.isActive)
    .map((m) => {
      const tenant = m.tenant as { name?: string } | { name?: string }[] | null;
      const row = Array.isArray(tenant) ? tenant[0] : tenant;
      return row?.name ?? "a workspace";
    });

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  return (
    <OnboardingClient
      email={user.email ?? ""}
      fullName={str(meta.full_name)}
      companyName={str(meta.company_name)}
      deactivatedFrom={create ? [] : deactivatedFrom}
    />
  );
}
