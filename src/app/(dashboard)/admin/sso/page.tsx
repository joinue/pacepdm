"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  KeyRound, Trash2, Loader2, Copy, CheckCircle2, AlertCircle, Clock,
} from "lucide-react";
import { toast } from "sonner";
import { fetchJson, errorMessage } from "@/lib/api-client";

interface Role {
  id: string;
  name: string;
}

type DomainStatus = "pending_verification" | "verified" | "active" | "error";

interface SsoDomain {
  id: string;
  domain: string;
  jitRoleId: string;
  status: DomainStatus;
  verificationToken: string | null;
  verificationRecordName: string | null;
  verifiedAt: string | null;
  providerId: string | null;
  metadataUrl: string | null;
  createdAt: string;
  role: { id: string; name: string } | null;
  existingUserCount: number;
}

const STATUS_LABEL: Record<DomainStatus, string> = {
  pending_verification: "Pending verification",
  verified: "Verified — awaiting IdP metadata",
  active: "Active",
  error: "Error",
};

const STATUS_VARIANT: Record<DomainStatus, "secondary" | "default" | "destructive" | "outline"> = {
  pending_verification: "outline",
  verified: "secondary",
  active: "default",
  error: "destructive",
};

export default function SsoAdminPage() {
  const [domains, setDomains] = useState<SsoDomain[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [newDomain, setNewDomain] = useState("");
  const [newRoleId, setNewRoleId] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [domainsRes, rolesRes] = await Promise.all([
        fetchJson<{ domains: SsoDomain[] }>("/api/admin/sso"),
        fetchJson<Role[]>("/api/roles"),
      ]);
      setDomains(domainsRes.domains || []);
      setRoles(rolesRes || []);
      if (!newRoleId && rolesRes && rolesRes.length > 0) {
        setNewRoleId(rolesRes[0].id);
      }
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to load SSO settings");
    } finally {
      setLoading(false);
    }
  }, [newRoleId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newDomain.trim() || !newRoleId) return;
    setAdding(true);
    try {
      await fetchJson("/api/admin/sso", {
        method: "POST",
        body: { domain: newDomain.trim(), jitRoleId: newRoleId },
      });
      toast.success("Domain added — next, verify DNS");
      setNewDomain("");
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-primary" />
          Single Sign-On
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Self-serve SAML SSO. Add a domain, prove you own it via DNS, paste your
          identity provider&rsquo;s metadata, and you&rsquo;re live — no support ticket.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a domain</CardTitle>
          <CardDescription>
            Users whose email ends in this domain will be redirected to your IdP
            once setup is complete.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="domain">Email domain</Label>
              <Input
                id="domain"
                type="text"
                placeholder="acme.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                Plain domain only — no https://, no path. Case-insensitive.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="role">Default role for new users</Label>
              <Select value={newRoleId} onValueChange={(v) => setNewRoleId(v || "")}>
                <SelectTrigger id="role">
                  <SelectValue placeholder="Select a role">
                    {(value) => roles.find((r) => r.id === value)?.name ?? "Select a role"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Users provisioned via SSO land in this role. You can change individual
                users later in the Users admin page.
              </p>
            </div>
            <Button type="submit" disabled={adding || !newDomain.trim() || !newRoleId}>
              {adding ? "Adding…" : "Add domain"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Domains
        </h3>
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        ) : domains.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No SSO domains yet.
            </CardContent>
          </Card>
        ) : (
          domains.map((d) => <DomainCard key={d.id} domain={d} onChange={load} />)
        )}
      </div>
    </div>
  );
}

function DomainCard({ domain, onChange }: { domain: SsoDomain; onChange: () => void }) {
  const [busy, setBusy] = useState<"verify" | "activate" | "delete" | null>(null);
  const [metadataUrl, setMetadataUrl] = useState("");
  const [metadataXml, setMetadataXml] = useState("");

  async function handleVerify() {
    setBusy("verify");
    try {
      await fetchJson(`/api/admin/sso/${domain.id}/verify`, { method: "POST" });
      toast.success("DNS verified — now add your IdP metadata");
      onChange();
    } catch (err) {
      toast.error(errorMessage(err) || "DNS verification failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleActivate() {
    if (!metadataUrl.trim() && !metadataXml.trim()) {
      toast.error("Paste your IdP metadata URL or XML");
      return;
    }
    if (domain.existingUserCount > 0) {
      const msg =
        `Activating SSO will migrate ${domain.existingUserCount} existing ` +
        `${domain.existingUserCount === 1 ? "user" : "users"} in this workspace to SAML login. ` +
        `On their next sign-in they'll be redirected to your IdP instead of entering a password. ` +
        `Continue?`;
      if (!confirm(msg)) return;
    }
    setBusy("activate");
    try {
      await fetchJson(`/api/admin/sso/${domain.id}/activate`, {
        method: "POST",
        body: {
          metadataUrl: metadataUrl.trim() || undefined,
          metadataXml: metadataXml.trim() || undefined,
        },
      });
      toast.success(`SSO active for ${domain.domain}`);
      setMetadataUrl("");
      setMetadataXml("");
      onChange();
    } catch (err) {
      toast.error(errorMessage(err) || "Activation failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!confirm(`Remove SSO for ${domain.domain}? Existing sessions keep working, but new sign-ins from this domain will fall back to password auth.`)) return;
    setBusy("delete");
    try {
      await fetchJson(`/api/admin/sso/${domain.id}`, { method: "DELETE" });
      toast.success(`Removed ${domain.domain}`);
      onChange();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  }

  function copy(text: string, label: string) {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Copy failed")
    );
  }

  const statusIcon =
    domain.status === "active" ? <CheckCircle2 className="w-4 h-4 text-primary" />
    : domain.status === "error" ? <AlertCircle className="w-4 h-4 text-destructive" />
    : <Clock className="w-4 h-4 text-muted-foreground" />;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-mono text-sm font-semibold">{domain.domain}</p>
            <Badge variant={STATUS_VARIANT[domain.status]} className="text-[10px]">
              <span className="flex items-center gap-1">
                {statusIcon}
                {STATUS_LABEL[domain.status]}
              </span>
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Default role: <span className="font-medium">{domain.role?.name || "unknown"}</span>
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleDelete}
          disabled={busy === "delete"}
          aria-label={`Remove ${domain.domain}`}
        >
          {busy === "delete" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {domain.status === "pending_verification" && (
          <>
            <div>
              <p className="text-sm font-medium mb-2">Step 1 — Verify DNS</p>
              <p className="text-xs text-muted-foreground mb-3">
                Add this TXT record at your DNS provider. Once it propagates (usually a
                few minutes), click Verify.
              </p>
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2 text-xs font-mono">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground shrink-0">Type:</span>
                  <span>TXT</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground shrink-0">Host:</span>
                  <span className="truncate">{domain.verificationRecordName}</span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => copy(domain.verificationRecordName || "", "Host")}
                  >
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground shrink-0">Value:</span>
                  <span className="truncate">{domain.verificationToken}</span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => copy(domain.verificationToken || "", "Token")}
                  >
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            </div>
            <Button onClick={handleVerify} disabled={busy === "verify"}>
              {busy === "verify" ? "Checking…" : "Verify DNS"}
            </Button>
          </>
        )}

        {(domain.status === "verified" || domain.status === "error") && (
          <>
            <div>
              <p className="text-sm font-medium mb-2">
                Step 2 — Add IdP metadata
              </p>
              <p className="text-xs text-muted-foreground mb-3">
                Export the SAML metadata from your identity provider (Okta, Azure AD,
                JumpCloud, etc.). Provide either a public URL Supabase can fetch, or
                paste the XML directly.
              </p>
              {domain.existingUserCount > 0 && (
                <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200 flex gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">
                      {domain.existingUserCount} existing{" "}
                      {domain.existingUserCount === 1 ? "user" : "users"} will be migrated
                    </p>
                    <p className="mt-0.5">
                      On their next sign-in, users with an <span className="font-mono">@{domain.domain}</span>{" "}
                      email will be redirected to your IdP instead of entering a password. Their
                      history, approvals, and checkouts stay intact.
                    </p>
                  </div>
                </div>
              )}
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`metadata-url-${domain.id}`} className="text-xs">
                    Metadata URL
                  </Label>
                  <Input
                    id={`metadata-url-${domain.id}`}
                    type="url"
                    placeholder="https://acme.okta.com/app/xxxx/sso/saml/metadata"
                    value={metadataUrl}
                    onChange={(e) => setMetadataUrl(e.target.value)}
                  />
                </div>
                <div className="text-center text-xs text-muted-foreground">
                  or
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`metadata-xml-${domain.id}`} className="text-xs">
                    Metadata XML
                  </Label>
                  <Textarea
                    id={`metadata-xml-${domain.id}`}
                    placeholder="<EntityDescriptor xmlns=..."
                    value={metadataXml}
                    onChange={(e) => setMetadataXml(e.target.value)}
                    className="font-mono text-xs min-h-30"
                  />
                </div>
              </div>
            </div>
            <Button onClick={handleActivate} disabled={busy === "activate"}>
              {busy === "activate" ? "Activating…" : "Activate SSO"}
            </Button>
          </>
        )}

        {domain.status === "active" && (
          <div className="text-xs text-muted-foreground space-y-1">
            <p>
              Users from <span className="font-mono">{domain.domain}</span> will be
              redirected to your IdP automatically on sign-in.
            </p>
            {domain.providerId && (
              <p className="font-mono truncate">Supabase provider ID: {domain.providerId}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
