"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight } from "lucide-react";

export function AuditDetails({ details }: { details: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const summary = Object.entries(details)
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");

  return (
    <div>
      <div className="flex items-center gap-1">
        <span className="truncate max-w-[200px]">{summary}</span>
        {Object.keys(details).length > 0 && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </Button>
        )}
      </div>
      {expanded && (
        <pre className="mt-1.5 p-2 rounded-md bg-muted text-xs font-mono overflow-x-auto max-w-sm">
          {JSON.stringify(details, null, 2)}
        </pre>
      )}
    </div>
  );
}
