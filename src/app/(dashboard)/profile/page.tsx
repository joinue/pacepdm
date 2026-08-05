"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useFetch } from "@/hooks/use-fetch";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";

type EmailPrefs = {
  approval: boolean;
  transition: boolean;
  checkout: boolean;
  eco: boolean;
  system: boolean;
};

const DEFAULT_PREFS: EmailPrefs = {
  approval: true,
  transition: true,
  checkout: true,
  eco: true,
  system: false,
};

const PREF_LABELS: Array<{ key: keyof EmailPrefs; label: string; hint: string }> = [
  {
    key: "approval",
    label: "Approvals",
    hint: "You're asked to approve, or a request you made is decided",
  },
  { key: "eco", label: "ECOs", hint: "An ECO you're involved in changes state" },
  {
    key: "transition",
    label: "File lifecycle",
    hint: "Files you own move between lifecycle states",
  },
  { key: "checkout", label: "Checkouts", hint: "A file you own is checked out or checked back in" },
  {
    key: "system",
    label: "System notices",
    hint: "Low-priority announcements from this workspace",
  },
];

export default function ProfilePage() {
  const user = useTenantUser();
  const supabase = createClient();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const [savingPrefs, setSavingPrefs] = useState(false);

  // The saved prefs are the source of truth; the checkboxes edit them in
  // place through `setData` until the user saves.
  const {
    data: prefsData,
    loading: prefsLoading,
    error: prefsError,
    setData: setPrefsData,
  } = useFetch<{ prefs: EmailPrefs }>("/api/profile/email-prefs");

  const prefs: EmailPrefs = { ...DEFAULT_PREFS, ...(prefsData?.prefs ?? {}) };

  const setPrefs = (updater: (prev: EmailPrefs) => EmailPrefs) =>
    setPrefsData((prev) => ({
      prefs: updater({ ...DEFAULT_PREFS, ...(prev?.prefs ?? {}) }),
    }));

  async function handleSavePrefs() {
    setSavingPrefs(true);
    try {
      await fetchJson("/api/profile/email-prefs", { method: "PATCH", body: prefs });
      toast.success("Email preferences saved");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSavingPrefs(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }

    setChangingPassword(true);

    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Password updated successfully");
      setNewPassword("");
      setConfirmPassword("");
    }
    setChangingPassword(false);
  }

  return (
    <PageContainer width="narrow">
      <PageHeader title="Profile" />
      <Card>
        <CardHeader>
          <CardTitle>Account Details</CardTitle>
          <CardDescription>Your workspace and role information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-y-3 text-sm">
            <span className="text-muted-foreground">Name</span>
            <span className="font-medium">{user.fullName}</span>
            <span className="text-muted-foreground">Email</span>
            <span className="font-medium">{user.email}</span>
            <span className="text-muted-foreground">Role</span>
            <span>
              <Badge variant="secondary">{user.role}</Badge>
            </span>
            <span className="text-muted-foreground">Workspace</span>
            <span className="font-medium">{user.tenantName}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email Notifications</CardTitle>
          <CardDescription>
            Pick which in-app notifications also arrive by email. Your workspace admin can disable
            all emails from settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {prefsLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : prefsError ? (
            <p className="text-sm text-destructive">{errorMessage(prefsError)}</p>
          ) : (
            <>
              {PREF_LABELS.map((p, i) => (
                <div key={p.key}>
                  {i > 0 && <Separator className="my-3" />}
                  <label className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      checked={prefs[p.key]}
                      onCheckedChange={(v) => setPrefs((prev) => ({ ...prev, [p.key]: !!v }))}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-medium">{p.label}</p>
                      <p className="text-xs text-muted-foreground">{p.hint}</p>
                    </div>
                  </label>
                </div>
              ))}
              <div className="pt-2">
                <Button onClick={handleSavePrefs} disabled={savingPrefs}>
                  {savingPrefs ? "Saving…" : "Save preferences"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change Password</CardTitle>
          <CardDescription>Update your account password</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="newPassword">New Password</Label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min. 6 characters"
                minLength={6}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm New Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter new password"
                required
              />
            </div>
            <Button type="submit" disabled={changingPassword}>
              {changingPassword ? "Updating..." : "Update Password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
