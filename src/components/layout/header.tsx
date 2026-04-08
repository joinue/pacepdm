"use client";

import { useTenantUser } from "@/components/providers/tenant-provider";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LogOut, User, Sun, Moon, Monitor } from "lucide-react";
import { toast } from "sonner";

export function Header() {
  const user = useTenantUser();
  const router = useRouter();
  const supabase = createClient();
  const { theme, setTheme } = useTheme();

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
    <header className="h-12 border-b bg-background/80 backdrop-blur-sm flex items-center justify-between px-6">
      <div />
      <div className="flex items-center gap-2">
        <div className="flex items-center border rounded-md">
          <Button
            variant="ghost" size="sm"
            className={`h-7 w-7 p-0 rounded-r-none ${theme === "light" ? "bg-muted" : ""}`}
            onClick={() => setTheme("light")}
          >
            <Sun className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost" size="sm"
            className={`h-7 w-7 p-0 rounded-none ${theme === "system" ? "bg-muted" : ""}`}
            onClick={() => setTheme("system")}
          >
            <Monitor className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost" size="sm"
            className={`h-7 w-7 p-0 rounded-l-none ${theme === "dark" ? "bg-muted" : ""}`}
            onClick={() => setTheme("dark")}
          >
            <Moon className="w-3.5 h-3.5" />
          </Button>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" className="flex items-center gap-2 h-8 px-2">
                <Avatar className="w-6 h-6">
                  <AvatarFallback className="text-[10px] bg-primary/10 text-primary font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm">{user.fullName}</span>
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="flex flex-col">
                <span className="text-sm">{user.fullName}</span>
                <span className="text-xs text-muted-foreground font-normal">{user.email}</span>
                <span className="text-xs text-muted-foreground font-normal mt-0.5">
                  {user.role} &middot; {user.tenantName}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <Link href="/profile">
              <DropdownMenuItem>
                <User className="w-4 h-4 mr-2" />
                Profile
              </DropdownMenuItem>
            </Link>
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
