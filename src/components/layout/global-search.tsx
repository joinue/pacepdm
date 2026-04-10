"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  CommandDialog,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import {
  FileText,
  Layers,
  Search,
  ArrowRight,
  ClipboardList,
  Cpu,
  FolderOpen,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface FileResult {
  id: string;
  name: string;
  partNumber: string | null;
  category: string;
  lifecycleState: string;
  folderId: string;
  folder?: { path: string };
}

interface ECOResult {
  id: string;
  ecoNumber: string;
  title: string;
  status: string;
}

interface PartResult {
  id: string;
  name: string;
  partNumber: string;
  category: string;
  lifecycleState: string;
}

interface BomResult {
  id: string;
  name: string;
  status: string;
}

interface FolderResult {
  id: string;
  name: string;
  path: string;
}

const lifecycleColors: Record<string, string> = {
  WIP: "warning",
  "In Review": "info",
  Released: "success",
  Obsolete: "error",
};

const ecoStatusColors: Record<string, string> = {
  DRAFT: "muted",
  SUBMITTED: "info",
  IN_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "error",
  IMPLEMENTED: "purple",
  CLOSED: "muted",
};

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileResult[]>([]);
  const [ecos, setEcos] = useState<ECOResult[]>([]);
  const [parts, setParts] = useState<PartResult[]>([]);
  const [boms, setBoms] = useState<BomResult[]>([]);
  const [folders, setFolders] = useState<FolderResult[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Keyboard shortcut: Ctrl+K / Cmd+K
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
      }
      // Also allow "/" when not focused on an input
      if (
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLSelectElement) &&
        !(e.target as HTMLElement)?.isContentEditable
      ) {
        e.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Closes the dialog and clears all transient state in one shot.
  // Centralizing this avoids the previous useEffect-on-open pattern, which
  // tripped the react-hooks rule against setState in effects.
  const closeAndReset = useCallback(() => {
    setOpen(false);
    setQuery("");
    setFiles([]);
    setEcos([]);
    setParts([]);
    setBoms([]);
    setFolders([]);
  }, []);

  const search = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setFiles([]);
        setEcos([]);
        setParts([]);
        setBoms([]);
        setFolders([]);
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        setFiles((data.files || []).slice(0, 5));
        setEcos((data.ecos || []).slice(0, 5));
        setParts((data.parts || []).slice(0, 5));
        setBoms((data.boms || []).slice(0, 5));
        setFolders((data.folders || []).slice(0, 5));
      } catch {
        setFiles([]);
        setEcos([]);
        setParts([]);
        setBoms([]);
        setFolders([]);
      }
      setLoading(false);
    },
    []
  );

  function handleValueChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(value), 250);
  }

  function selectFile(file: FileResult) {
    closeAndReset();
    router.push(`/vault?folderId=${file.folderId}&fileId=${file.id}`);
  }

  function selectEco(eco: ECOResult) {
    closeAndReset();
    router.push(`/ecos?ecoId=${eco.id}`);
  }

  function selectPart(part: PartResult) {
    closeAndReset();
    router.push(`/parts?partId=${part.id}`);
  }

  function selectBom(bom: BomResult) {
    closeAndReset();
    router.push(`/boms?bomId=${bom.id}`);
  }

  function selectFolder(folder: FolderResult) {
    closeAndReset();
    router.push(`/vault?folderId=${folder.id}`);
  }

  function goToFullSearch() {
    closeAndReset();
    router.push(`/search?q=${encodeURIComponent(query)}`);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && hasQuery && !hasResults && !loading) {
      goToFullSearch();
    }
  }

  const hasResults = files.length > 0 || ecos.length > 0 || parts.length > 0 || boms.length > 0 || folders.length > 0;
  const hasQuery = query.trim().length > 0;

  return (
    <>
      {/* Pill trigger button */}
      <button
        onClick={() => setOpen(true)}
        className="hidden sm:flex items-center gap-2 h-7 pl-2.5 pr-2 rounded-full border border-border/50 bg-muted/50 text-muted-foreground text-xs hover:bg-muted hover:border-border hover:text-foreground transition-all duration-150 cursor-pointer"
      >
        <Search className="w-3 h-3" />
        <span>Search...</span>
        <kbd className="pointer-events-none ml-1 inline-flex h-4.5 items-center gap-0.5 rounded border border-border/60 bg-background/80 px-1 font-mono text-[10px] font-medium text-muted-foreground/70">
          <span className="text-[11px]">⌘</span>K
        </kbd>
      </button>

      {/* Mobile trigger */}
      <button
        onClick={() => setOpen(true)}
        className="sm:hidden flex items-center justify-center h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
      >
        <Search className="w-3.5 h-3.5" />
      </button>

      {/* Command palette dialog */}
      <CommandDialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : closeAndReset())}
        title="Search"
        description="Search for files, folders, ECOs, parts, and BOMs"
        className="sm:max-w-lg"
      >
        <Command shouldFilter={false} onKeyDown={handleKeyDown}>
          <CommandInput
            placeholder="Search files, folders, ECOs, parts, BOMs..."
            value={query}
            onValueChange={handleValueChange}
          />
          <CommandList>
            {loading && hasQuery && (
              <div className="py-4 text-center text-xs text-muted-foreground">
                Searching...
              </div>
            )}

            {!loading && hasQuery && !hasResults && (
              <CommandEmpty>
                <div className="flex flex-col items-center gap-2">
                  <span>No results found.</span>
                  <button
                    className="text-xs text-primary hover:underline cursor-pointer"
                    onClick={goToFullSearch}
                  >
                    Search for &ldquo;{query}&rdquo; on the full search page &rarr;
                  </button>
                </div>
              </CommandEmpty>
            )}

            {!hasQuery && !loading && (
              <div className="py-8 text-center text-xs text-muted-foreground">
                Start typing to search across files, folders, ECOs, parts, and BOMs
              </div>
            )}

            {files.length > 0 && (
              <CommandGroup heading="Files">
                {files.map((file) => (
                  <CommandItem
                    key={`file-${file.id}`}
                    value={`file-${file.id}`}
                    onSelect={() => selectFile(file)}
                  >
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm truncate">{file.name}</span>
                      <span className="text-[11px] text-muted-foreground truncate">
                        {file.partNumber && `${file.partNumber} · `}
                        {file.folder?.path || file.category}
                      </span>
                    </div>
                    <Badge
                      variant={
                        (lifecycleColors[file.lifecycleState] as
                          | "warning"
                          | "info"
                          | "success"
                          | "error") || "secondary"
                      }
                      className="ml-auto text-[10px] px-1.5 py-0 shrink-0"
                    >
                      {file.lifecycleState}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {ecos.length > 0 && (
              <>
                {files.length > 0 && <CommandSeparator />}
                <CommandGroup heading="ECOs">
                  {ecos.map((eco) => (
                    <CommandItem
                      key={`eco-${eco.id}`}
                      value={`eco-${eco.id}`}
                      onSelect={() => selectEco(eco)}
                    >
                      <ClipboardList className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm truncate">{eco.title}</span>
                        <span className="text-[11px] text-muted-foreground truncate">
                          {eco.ecoNumber}
                        </span>
                      </div>
                      <Badge
                        variant={
                          (ecoStatusColors[eco.status] as
                            | "warning"
                            | "info"
                            | "success"
                            | "error"
                            | "purple"
                            | "muted") || "secondary"
                        }
                        className="ml-auto text-[10px] px-1.5 py-0 shrink-0"
                      >
                        {eco.status.replace("_", " ")}
                      </Badge>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {parts.length > 0 && (
              <>
                {(files.length > 0 || ecos.length > 0) && <CommandSeparator />}
                <CommandGroup heading="Parts">
                  {parts.map((part) => (
                    <CommandItem
                      key={`part-${part.id}`}
                      value={`part-${part.id}`}
                      onSelect={() => selectPart(part)}
                    >
                      <Cpu className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm truncate">{part.name}</span>
                        <span className="text-[11px] text-muted-foreground truncate">
                          {part.partNumber} · {part.category}
                        </span>
                      </div>
                      <Badge
                        variant={
                          (lifecycleColors[part.lifecycleState] as
                            | "warning"
                            | "info"
                            | "success"
                            | "error") || "secondary"
                        }
                        className="ml-auto text-[10px] px-1.5 py-0 shrink-0"
                      >
                        {part.lifecycleState}
                      </Badge>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {boms.length > 0 && (
              <>
                {(files.length > 0 || ecos.length > 0 || parts.length > 0) && <CommandSeparator />}
                <CommandGroup heading="BOMs">
                  {boms.map((bom) => (
                    <CommandItem
                      key={`bom-${bom.id}`}
                      value={`bom-${bom.id}`}
                      onSelect={() => selectBom(bom)}
                    >
                      <Layers className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm truncate">{bom.name}</span>
                      </div>
                      {bom.status && (
                        <Badge
                          variant="secondary"
                          className="ml-auto text-[10px] px-1.5 py-0 shrink-0"
                        >
                          {bom.status}
                        </Badge>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {folders.length > 0 && (
              <>
                {(files.length > 0 || ecos.length > 0 || parts.length > 0 || boms.length > 0) && <CommandSeparator />}
                <CommandGroup heading="Folders">
                  {folders.map((folder) => (
                    <CommandItem
                      key={`folder-${folder.id}`}
                      value={`folder-${folder.id}`}
                      onSelect={() => selectFolder(folder)}
                    >
                      <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm truncate">{folder.name}</span>
                        <span className="text-[11px] text-muted-foreground truncate">
                          {folder.path}
                        </span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {hasQuery && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="full-search"
                    onSelect={goToFullSearch}
                  >
                    <ArrowRight className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm">
                      See all results for &ldquo;{query}&rdquo;
                    </span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
