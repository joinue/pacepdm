"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Search, Lock, Download } from "lucide-react";

interface SearchResult {
  id: string;
  name: string;
  partNumber: string | null;
  description: string | null;
  category: string;
  currentVersion: number;
  lifecycleState: string;
  isCheckedOut: boolean;
  checkedOutBy: { fullName: string } | null;
  updatedAt: string;
  folderId: string;
  folder: { path: string };
}

const lifecycleColors: Record<string, string> = {
  WIP: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  "In Review": "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Released: "bg-green-500/10 text-green-600 dark:text-green-400",
  Obsolete: "bg-red-500/10 text-red-600 dark:text-red-400",
};

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [state, setState] = useState("all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const router = useRouter();

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setSearched(true);

    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (category !== "all") params.set("category", category);
    if (state !== "all") params.set("state", state);

    try {
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
    } catch {
      setResults([]);
    }
    setLoading(false);
  }

  async function handleDownload(fileId: string) {
    const res = await fetch(`/api/files/${fileId}/download`);
    const d = await res.json();
    if (d.url) window.open(d.url, "_blank");
  }

  function navigateToFile(file: SearchResult) {
    router.push(`/vault?folderId=${file.folderId}&fileId=${file.id}`);
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Search</h2>

      <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3 sm:items-end">
        <div className="flex-1">
          <Input
            placeholder="Search by filename, part number, or description..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
        <Select value={category} onValueChange={(v) => setCategory(v ?? "all")}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="PART">Part</SelectItem>
            <SelectItem value="ASSEMBLY">Assembly</SelectItem>
            <SelectItem value="DRAWING">Drawing</SelectItem>
            <SelectItem value="DOCUMENT">Document</SelectItem>
            <SelectItem value="PURCHASED">Purchased</SelectItem>
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={(v) => setState(v ?? "all")}>
          <SelectTrigger className="w-full sm:w-36">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All States</SelectItem>
            <SelectItem value="WIP">WIP</SelectItem>
            <SelectItem value="In Review">In Review</SelectItem>
            <SelectItem value="Released">Released</SelectItem>
            <SelectItem value="Obsolete">Obsolete</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={loading} className="shrink-0">
          <Search className="w-4 h-4 sm:mr-2" />
          <span className="hidden sm:inline">{loading ? "Searching..." : "Search"}</span>
        </Button>
        </div>
      </form>

      {searched && (
        <>
          {results.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground text-sm">No files found.</p>
          ) : (
            <>
              {/* Mobile list */}
              <div className="md:hidden space-y-1">
                {results.map((file) => (
                  <div key={file.id} className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 cursor-pointer" onClick={() => navigateToFile(file)}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium truncate">{file.name}</p>
                        {file.isCheckedOut && <Lock className="w-3 h-3 text-red-500 shrink-0" />}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${lifecycleColors[file.lifecycleState] || ""}`}>{file.lifecycleState}</Badge>
                        <span className="text-[11px] text-muted-foreground">{file.folder?.path}</span>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" onClick={(e) => { e.stopPropagation(); handleDownload(file.id); }}>
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              {/* Desktop table */}
              <div className="hidden md:block border rounded-lg bg-background">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Part #</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Ver</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Modified</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((file) => (
                      <TableRow key={file.id} className="cursor-pointer hover:bg-muted/50" onClick={() => navigateToFile(file)}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-1">
                            {file.name}
                            {file.isCheckedOut && <Lock className="w-3 h-3 text-red-500" />}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{file.partNumber || "—"}</TableCell>
                        <TableCell className="text-sm">{file.category}</TableCell>
                        <TableCell className="font-mono text-xs">v{file.currentVersion}</TableCell>
                        <TableCell>
                          <Badge variant="secondary" className={lifecycleColors[file.lifecycleState] || ""}>{file.lifecycleState}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">{file.folder?.path}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{new Date(file.updatedAt).toLocaleDateString()}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={(e) => { e.stopPropagation(); handleDownload(file.id); }}>
                            <Download className="w-3.5 h-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
