import { getCurrentTenantUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/db";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  FileText,
  ClipboardList,
  CheckCircle,
  Inbox,
  Bell,
  AlertTriangle,
  ChevronRight,
  Folder as FolderIcon,
} from "lucide-react";
import Link from "next/link";
import { FormattedDate } from "@/components/ui/formatted-date";
import { EmptyState } from "@/components/ui/empty-state";

// Checkouts older than this are surfaced as "stale" — long-held checkouts
// block teammates, so the dashboard nudges the owner to check them back in.
const STALE_CHECKOUT_DAYS = 7;

// ECO statuses that still need the owner's attention. Terminal states
// (REJECTED, IMPLEMENTED, CLOSED) are excluded from the "open" count.
const OPEN_ECO_STATUSES = ["DRAFT", "SUBMITTED", "IN_REVIEW", "APPROVED"];

// Supabase's generated types model the `folder:folders(...)` join as an
// array even though files_folderId_fkey is a to-one relation — we unwrap
// at render time.
type MyCheckoutRow = {
  id: string;
  name: string;
  checkedOutAt: string | null;
  folder: { name: string }[] | { name: string } | null;
};

type PendingDecisionRow = {
  createdAt: string;
  request: { status: string } | null;
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function ageLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

function oldestAgeSubtitle(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "Oldest: today";
  if (days === 1) return "Oldest: 1 day ago";
  return `Oldest: ${days} days ago`;
}

export default async function DashboardPage() {
  const tenantUser = await getCurrentTenantUser();
  const tenantId = tenantUser.tenantId;
  const db = getServiceClient();

  // The pending-approval query depends on this user's group memberships,
  // so it's sequenced before the Promise.all fan-out.
  const { data: memberships } = await db
    .from("approval_group_members")
    .select("groupId")
    .eq("userId", tenantUser.id);
  const groupIds = (memberships ?? []).map((m) => m.groupId);

  const pendingDecisionsPromise = groupIds.length
    ? db
        .from("approval_decisions")
        .select(
          "createdAt, request:approval_requests!approval_decisions_requestId_fkey(status)"
        )
        .in("groupId", groupIds)
        .eq("status", "PENDING")
        .order("createdAt", { ascending: true })
    : Promise.resolve({ data: [] as PendingDecisionRow[] });

  const [
    { data: rawPendingDecisions },
    { data: myCheckouts },
    { count: openEcoCount, data: latestEco },
    { count: unreadNotifications },
    { data: recentActivity },
  ] = await Promise.all([
    pendingDecisionsPromise,
    db
      .from("files")
      .select(
        "id, name, checkedOutAt, folder:folders!files_folderId_fkey(name)"
      )
      .eq("tenantId", tenantId)
      .eq("checkedOutById", tenantUser.id)
      .eq("isCheckedOut", true)
      .order("checkedOutAt", { ascending: true }),
    db
      .from("ecos")
      .select("updatedAt", { count: "exact" })
      .eq("tenantId", tenantId)
      .eq("createdById", tenantUser.id)
      .in("status", OPEN_ECO_STATUSES)
      .order("updatedAt", { ascending: false })
      .limit(1),
    db
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("tenantId", tenantId)
      .eq("userId", tenantUser.id)
      .eq("isRead", false),
    db
      .from("audit_logs")
      .select("*, user:tenant_users!audit_logs_userId_fkey(fullName)")
      .eq("tenantId", tenantId)
      .order("createdAt", { ascending: false })
      .limit(10),
  ]);

  // Mirror the /api/approvals filter: only surface decisions whose parent
  // request is still PENDING (the decision row alone can outlive the
  // request when a sibling step rejects or recalls it).
  const myPending = ((rawPendingDecisions ?? []) as PendingDecisionRow[])
    .filter((d) => d.request?.status === "PENDING");
  const pendingApprovalsCount = myPending.length;
  const oldestPendingApprovalAge = daysSince(myPending[0]?.createdAt ?? null);

  const checkoutRows = (myCheckouts ?? []) as MyCheckoutRow[];
  const checkoutsCount = checkoutRows.length;
  const staleCheckoutsCount = checkoutRows.filter((f) => {
    const age = daysSince(f.checkedOutAt);
    return age !== null && age >= STALE_CHECKOUT_DAYS;
  }).length;

  const latestEcoUpdate = latestEco?.[0]?.updatedAt ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Dashboard</h2>
        <p className="text-muted-foreground">
          Welcome back, {tenantUser.fullName}
        </p>
      </div>

      {/* "For you" cards — actionable counts, each with a secondary line
          showing the most relevant follow-up (oldest age, stale count, etc). */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <ForYouCard
          href="/approvals"
          icon={CheckCircle}
          title="Approvals waiting on me"
          count={pendingApprovalsCount}
          emptyLabel="All caught up"
          subtitle={
            pendingApprovalsCount > 0
              ? oldestAgeSubtitle(oldestPendingApprovalAge)
              : null
          }
          highlight={pendingApprovalsCount > 0}
        />
        <ForYouCard
          href="/vault?view=checkouts"
          icon={FileText}
          title="My checked-out files"
          count={checkoutsCount}
          emptyLabel="Nothing checked out"
          subtitle={
            staleCheckoutsCount > 0
              ? `${staleCheckoutsCount} stale (>${STALE_CHECKOUT_DAYS}d)`
              : checkoutsCount > 0
                ? "All recent"
                : null
          }
          warn={staleCheckoutsCount > 0}
        />
        <ForYouCard
          href="/ecos"
          icon={ClipboardList}
          title="My open ECOs"
          count={openEcoCount ?? 0}
          emptyLabel="No open ECOs"
          subtitle={
            (openEcoCount ?? 0) > 0 && latestEcoUpdate
              ? <>Updated <FormattedDate date={latestEcoUpdate} variant="date" /></>
              : null
          }
        />
        <ForYouCard
          href="/notifications"
          icon={Bell}
          title="Unread notifications"
          count={unreadNotifications ?? 0}
          emptyLabel="No new notifications"
          subtitle={null}
          highlight={(unreadNotifications ?? 0) > 0}
        />
      </div>

      {/* Stale / open checkouts panel — the single biggest HQ-style win.
          Sorted oldest-first so the files most likely blocking teammates
          show at the top. Hidden entirely when the user has nothing out. */}
      {checkoutRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your checked-out files</CardTitle>
            <CardDescription>
              Teammates can&apos;t edit these until you check them back in.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="divide-y">
              {checkoutRows.slice(0, 6).map((file) => {
                const age = daysSince(file.checkedOutAt);
                const isStale = age !== null && age >= STALE_CHECKOUT_DAYS;
                const folderName = Array.isArray(file.folder)
                  ? file.folder[0]?.name
                  : file.folder?.name;
                return (
                  <li key={file.id}>
                    <Link
                      href={`/vault?view=checkouts&fileId=${file.id}`}
                      className="flex items-center gap-3 py-2.5 hover:bg-muted/40 -mx-2 px-2 rounded-md transition-colors"
                    >
                      <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                        <FileText className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {file.name}
                        </div>
                        {folderName && (
                          <div className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                            <FolderIcon className="w-3 h-3 shrink-0" />
                            <span className="truncate">{folderName}</span>
                          </div>
                        )}
                      </div>
                      {age !== null && (
                        <Badge
                          variant={isStale ? "warning" : "muted"}
                          className="text-[10px] shrink-0"
                        >
                          {isStale && <AlertTriangle className="w-3 h-3 mr-0.5" />}
                          {ageLabel(age)}
                        </Badge>
                      )}
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    </Link>
                  </li>
                );
              })}
            </ul>
            {checkoutRows.length > 6 && (
              <div className="pt-3 text-right">
                <Link
                  href="/vault?view=checkouts"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  View all {checkoutRows.length} →
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest actions across the vault</CardDescription>
        </CardHeader>
        <CardContent>
          {!recentActivity || recentActivity.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No activity yet"
              description="Start by uploading files to the vault."
            />
          ) : (
            <div className="space-y-3">
              {recentActivity.map((log) => (
                <div
                  key={log.id}
                  className="flex items-center justify-between text-sm border-b pb-2 last:border-0"
                >
                  <div>
                    <span className="font-medium">
                      {log.user?.fullName ?? "System"}
                    </span>{" "}
                    <span className="text-muted-foreground">{log.action}</span>{" "}
                    <span className="text-muted-foreground">{log.entityType}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    <FormattedDate date={log.createdAt} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ----- ForYouCard ---------------------------------------------------------

type ForYouCardProps = {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  count: number;
  emptyLabel: string;
  subtitle: React.ReactNode;
  highlight?: boolean;
  warn?: boolean;
};

function ForYouCard({
  href,
  icon: Icon,
  title,
  count,
  emptyLabel,
  subtitle,
  highlight,
  warn,
}: ForYouCardProps) {
  const accent = warn
    ? "text-amber-600 dark:text-amber-500"
    : highlight && count > 0
      ? "text-foreground"
      : "text-muted-foreground";

  return (
    <Link href={href}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {title}
          </CardTitle>
          <Icon className={`w-4 h-4 ${accent}`} />
        </CardHeader>
        <CardContent>
          <div className={`text-2xl font-bold ${accent}`}>{count}</div>
          <div className="text-xs text-muted-foreground mt-0.5 min-h-4">
            {count === 0 ? emptyLabel : subtitle}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
