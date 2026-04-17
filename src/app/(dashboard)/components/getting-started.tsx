"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Upload, Package, ListTree, ClipboardList, Check, X, Rocket,
} from "lucide-react";

interface GettingStartedProps {
  hasFiles: boolean;
  hasParts: boolean;
  hasBoms: boolean;
  hasEcos: boolean;
}

const DISMISS_KEY = "pace-pdm-getting-started-dismissed";

export function GettingStarted({ hasFiles, hasParts, hasBoms, hasEcos }: GettingStartedProps) {
  const [dismissed, setDismissed] = useState(true); // default hidden to avoid flash

  useEffect(() => {
    queueMicrotask(() => setDismissed(localStorage.getItem(DISMISS_KEY) === "1"));
  }, []);

  const allDone = hasFiles && hasParts && hasBoms && hasEcos;

  if (dismissed || allDone) return null;

  const steps = [
    { done: hasFiles, label: "Upload a file to the vault", href: "/vault", icon: Upload },
    { done: hasParts, label: "Create your first part", href: "/parts", icon: Package },
    { done: hasBoms,  label: "Build a bill of materials", href: "/boms",  icon: ListTree },
    { done: hasEcos,  label: "Submit an engineering change", href: "/ecos", icon: ClipboardList },
  ];

  const completedCount = steps.filter((s) => s.done).length;

  function handleDismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  }

  return (
    <Card className="relative overflow-hidden border-primary/30 bg-linear-to-br from-primary/8 via-primary/3 to-transparent shadow-sm shadow-primary/5">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-linear-to-r from-primary/20 via-primary/60 to-primary/20" />
      <CardHeader className="flex flex-row items-start justify-between pb-3">
        <div className="flex items-center gap-2">
          <Rocket className="w-4 h-4 text-primary" />
          <CardTitle className="text-base">Getting started</CardTitle>
          <span className="text-xs text-muted-foreground ml-1">{completedCount}/{steps.length}</span>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={handleDismiss} title="Dismiss">
          <X className="w-3.5 h-3.5" />
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid sm:grid-cols-2 gap-2">
          {steps.map((step) => (
            <Link
              key={step.href}
              href={step.href}
              className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                step.done
                  ? "bg-muted/30 border-muted"
                  : "hover:border-primary/30 hover:bg-primary/5"
              }`}
            >
              <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                step.done
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground"
              }`}>
                {step.done ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <step.icon className="w-3.5 h-3.5" />
                )}
              </div>
              <span className={`text-sm ${step.done ? "text-muted-foreground line-through" : "font-medium"}`}>
                {step.label}
              </span>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
