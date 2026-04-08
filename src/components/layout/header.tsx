"use client";

import { useState, useEffect } from "react";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LogOut, User, Sun, Moon, Menu } from "lucide-react";
import { toast } from "sonner";

export function Header({ onMenuClick }: { onMenuClick: () => void }) {
  const user = useTenantUser();
  const router = useRouter();
  const supabase = createClient();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const initials = user.fullName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  async function handleSignOut() {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        toast.error("Failed to sign out: " + error.message);
        return;
      }
      router.refresh();
      router.push("/login");
    } catch {
      toast.error("Failed to sign out");
    }
  }

  return (
    <header className="h-12 flex items-center justify-between px-4 md:px-5">
      <div className="flex items-center gap-3">
        {/* Mobile menu button */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 md:hidden"
          onClick={onMenuClick}
        >
          <Menu className="w-4 h-4" />
        </Button>
        <span className="text-xs text-muted-foreground/50 hidden sm:block">
          {user.tenantName}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {mounted && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {resolvedTheme === "dark" ? (
              <Sun className="w-3.5 h-3.5" />
            ) : (
              <Moon className="w-3.5 h-3.5" />
            )}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" className="flex items-center gap-2 h-8 px-2">
                <Avatar className="w-6 h-6">
                  <AvatarFallback className="text-[10px] bg-foreground/8 text-foreground font-medium">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <span className="text-[13px] hidden sm:inline">{user.fullName}</span>
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{user.fullName}</span>
                  <span className="text-xs text-muted-foreground font-normal">{user.email}</span>
                  <span className="text-[11px] text-muted-foreground/60 font-normal mt-0.5">
                    {user.role}
                  </span>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push("/profile")}>
              <User className="w-4 h-4 mr-2" />
              Profile
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
