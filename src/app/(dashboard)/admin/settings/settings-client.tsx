"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Save, Building2, HardDrive, FileType, Bell, Hash } from "lucide-react";
import { toast } from "sonner";

export interface TenantSettings {
  maxUploadSizeMb: number;
  allowedExtensions: string;
  revisionScheme: "ALPHA" | "NUMERIC";
  requireCheckoutComment: boolean;
  emailNotifications: boolean;
  digestFrequency: "REALTIME" | "DAILY" | "WEEKLY";
  autoReleasePrefix: string;
  partNumberMode: "AUTO" | "MANUAL";
  partNumberPrefix: string;
  partNumberPadding: number;
}

const DEFAULT_SETTINGS: TenantSettings = {
  maxUploadSizeMb: 100,
  allowedExtensions: "",
  revisionScheme: "ALPHA",
  requireCheckoutComment: false,
  emailNotifications: true,
  digestFrequency: "DAILY",
  autoReleasePrefix: "REL-",
  partNumberMode: "AUTO",
  partNumberPrefix: "PRT-",
  partNumberPadding: 5,
};

export function SettingsClient({
  tenantName,
  tenantSlug,
  initialSettings,
}: {
  tenantName: string;
  tenantSlug: string;
  initialSettings: Partial<TenantSettings>;
}) {
  const [name, setName] = useState(tenantName);
  const [settings, setSettings] = useState<TenantSettings>({
    ...DEFAULT_SETTINGS,
    ...initialSettings,
  });
  const [saving, setSaving] = useState(false);

  function updateSetting<K extends keyof TenantSettings>(key: K, value: TenantSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, settings }),
    });

    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
    } else {
      toast.success("Settings saved.");
    }
    setSaving(false);
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-2xl font-bold">Settings</h2>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Workspace */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="w-4 h-4 text-primary" />
              Workspace
            </CardTitle>
            <CardDescription>General workspace identity</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Company Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Workspace ID</Label>
              <Input value={tenantSlug} disabled className="text-muted-foreground" />
              <p className="text-xs text-muted-foreground">This cannot be changed.</p>
            </div>
          </CardContent>
        </Card>

        {/* File Management */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <HardDrive className="w-4 h-4 text-primary" />
              File Management
            </CardTitle>
            <CardDescription>
              Control upload limits and file handling behavior
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="maxUpload">Maximum Upload Size (MB)</Label>
              <Input
                id="maxUpload"
                type="number"
                min={1}
                max={2048}
                value={settings.maxUploadSizeMb}
                onChange={(e) => updateSetting("maxUploadSizeMb", parseInt(e.target.value) || 100)}
              />
              <p className="text-xs text-muted-foreground">
                Individual file size limit. Max 2048 MB.
              </p>
            </div>
            <Separator />
            <div className="space-y-2">
              <Label htmlFor="extensions">Allowed File Extensions</Label>
              <Input
                id="extensions"
                value={settings.allowedExtensions}
                onChange={(e) => updateSetting("allowedExtensions", e.target.value)}
                placeholder=".step, .stp, .iges, .pdf, .dwg, .dxf"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated list. Leave blank to allow all file types.
              </p>
            </div>
            <Separator />
            <label className="flex items-start gap-3 cursor-pointer">
              <Checkbox
                checked={settings.requireCheckoutComment}
                onCheckedChange={(v) => updateSetting("requireCheckoutComment", !!v)}
                className="mt-0.5"
              />
              <div>
                <p className="text-sm font-medium">Require checkout comment</p>
                <p className="text-xs text-muted-foreground">
                  Users must provide a reason when checking out a file
                </p>
              </div>
            </label>
          </CardContent>
        </Card>

        {/* Revision & Naming */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileType className="w-4 h-4 text-primary" />
              Revision & Naming
            </CardTitle>
            <CardDescription>
              Configure how file revisions and releases are labeled
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Revision Scheme</Label>
              <Select
                value={settings.revisionScheme}
                onValueChange={(v) => updateSetting("revisionScheme", v as "ALPHA" | "NUMERIC")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALPHA">Alphabetic (A, B, C, ...)</SelectItem>
                  <SelectItem value="NUMERIC">Numeric (1, 2, 3, ...)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Determines how new revision letters/numbers are assigned
              </p>
            </div>
            <Separator />
            <div className="space-y-2">
              <Label htmlFor="releasePrefix">Release Number Prefix</Label>
              <Input
                id="releasePrefix"
                value={settings.autoReleasePrefix}
                onChange={(e) => updateSetting("autoReleasePrefix", e.target.value)}
                placeholder="REL-"
              />
              <p className="text-xs text-muted-foreground">
                Prepended to auto-generated release numbers (e.g., REL-001)
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Part Numbering */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Hash className="w-4 h-4 text-primary" />
              Part Numbering
            </CardTitle>
            <CardDescription>
              How new parts get a number when created
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Numbering Mode</Label>
              <Select
                value={settings.partNumberMode}
                onValueChange={(v) => updateSetting("partNumberMode", v as "AUTO" | "MANUAL")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AUTO">Auto (server assigns next number)</SelectItem>
                  <SelectItem value="MANUAL">Manual (user types each number)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Separator />
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="partPrefix">Prefix</Label>
                <Input
                  id="partPrefix"
                  value={settings.partNumberPrefix}
                  onChange={(e) => updateSetting("partNumberPrefix", e.target.value)}
                  placeholder="PRT-"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="partPadding">Zero-Padding Width</Label>
                <Input
                  id="partPadding"
                  type="number"
                  min={1}
                  max={12}
                  value={settings.partNumberPadding}
                  onChange={(e) => updateSetting("partNumberPadding", parseInt(e.target.value) || 5)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Preview: <span className="font-mono">{settings.partNumberPrefix}{"1".padStart(settings.partNumberPadding, "0")}</span>
              {", "}
              <span className="font-mono">{settings.partNumberPrefix}{"2".padStart(settings.partNumberPadding, "0")}</span>, …
            </p>
          </CardContent>
        </Card>

        {/* Notifications */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bell className="w-4 h-4 text-primary" />
              Notifications
            </CardTitle>
            <CardDescription>
              Configure how workspace members receive notifications
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <Checkbox
                checked={settings.emailNotifications}
                onCheckedChange={(v) => updateSetting("emailNotifications", !!v)}
                className="mt-0.5"
              />
              <div>
                <p className="text-sm font-medium">Email notifications</p>
                <p className="text-xs text-muted-foreground">
                  Send email alerts for approvals, check-ins, and ECO updates
                </p>
              </div>
            </label>
            <Separator />
            <div className="space-y-2">
              <Label>Digest Frequency</Label>
              <Select
                value={settings.digestFrequency}
                onValueChange={(v) => updateSetting("digestFrequency", v as "REALTIME" | "DAILY" | "WEEKLY")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="REALTIME">Real-time</SelectItem>
                  <SelectItem value="DAILY">Daily digest</SelectItem>
                  <SelectItem value="WEEKLY">Weekly digest</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                How often to batch non-critical notifications. Approvals always send immediately.
              </p>
            </div>
          </CardContent>
        </Card>

        <Button type="submit" disabled={saving} className="w-full sm:w-auto">
          <Save className="w-4 h-4 mr-2" />
          {saving ? "Saving..." : "Save All Settings"}
        </Button>
      </form>
    </div>
  );
}
