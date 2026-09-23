"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { FormattedDate } from "@/components/ui/formatted-date";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, Loader2, Megaphone, Paperclip, Pencil, Trash2, Users, X } from "lucide-react";
import { useFetch } from "@/hooks/use-fetch";
import { usePermissions } from "@/hooks/use-permissions";
import { useRealtimeTable } from "@/hooks/use-realtime-table";
import { useRealtimeEchoGuard } from "@/hooks/use-realtime-echo-guard";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { fetchJson, uploadFile, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { PERMISSIONS } from "@/lib/permissions";
import {
  CHANGE_LOG_CATEGORIES,
  DEFAULT_CATEGORY,
  categoryLabel,
  postLines,
  readsAsList,
} from "@/lib/change-log";
import { CommentThread, type Comment } from "./comment-thread";
import { initials, personName, type Person } from "./people";

/**
 * The change log: what engineering changed, for the people who answer
 * customers about it.
 *
 * A feed rather than a document because the unit is one change, told once,
 * and because "who has seen this" only means something per post. Nothing here
 * approves anything — see the route for why that matters.
 */

interface Attachment {
  id: string;
  fileName: string;
  sizeBytes: number | null;
}

interface Post {
  id: string;
  body: string;
  category: string;
  createdAt: string;
  editedAt: string | null;
  authorId: string | null;
  author: Person;
  attachments: Attachment[];
  comments: Comment[];
  readBy: { userId: string; reader: Person }[];
  readByMe: boolean;
}

/**
 * A dot per category rather than a filled pill.
 *
 * Five saturated badges down a feed read as five warnings; the dot says which
 * kind at a glance and leaves the words to carry the post.
 */
const CATEGORY_DOT: Record<string, string> = {
  DESIGN: "bg-info",
  LEAD_TIME: "bg-warning",
  PRICING: "bg-chart-4",
  DOCUMENTATION: "bg-chart-3",
  GENERAL: "bg-neutral",
};

function CategoryMark({ category }: { category: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span
        aria-hidden
        className={cn("size-2 rounded-full", CATEGORY_DOT[category] ?? "bg-neutral")}
      />
      {categoryLabel(category)}
    </span>
  );
}

/**
 * The day a post belongs to, as a person would say it.
 *
 * The feed is read by someone catching up, and "what landed today" is the
 * question they are asking — so the days are the structure, and the timestamp
 * on each post is the detail.
 */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** Posts in the order given, grouped into the day each was written. */
function byDay(posts: Post[]): { day: string; posts: Post[] }[] {
  const days: { day: string; posts: Post[] }[] = [];
  for (const post of posts) {
    const day = dayLabel(post.createdAt);
    const last = days[days.length - 1];
    if (last && last.day === day) last.posts.push(post);
    else days.push({ day, posts: [post] });
  }
  return days;
}

function fileSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A post's words: a paragraph as it was written, a list as a list. */
function PostBody({ body }: { body: string }) {
  const lines = postLines(body);
  if (!readsAsList(body)) return <p className="text-sm whitespace-pre-wrap">{lines[0] ?? body}</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

export function ChangeLogView() {
  const { can } = usePermissions();
  const canPost = can(PERMISSIONS.CHANGELOG_POST);
  const isAdmin = can("*");
  const user = useTenantUser();

  const { data, loading, error, setData, refetch } = useFetch<{ posts: Post[] }>("/api/change-log");
  const posts = useMemo(() => data?.posts ?? [], [data]);

  const [category, setCategory] = useState<string>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  const { markLocalWrite, isEcho } = useRealtimeEchoGuard();
  const onRemoteChange = () => {
    if (isEcho()) return;
    void refetch();
  };
  useRealtimeTable({
    table: "change_log_posts",
    filter: `tenantId=eq.${user.tenantId}`,
    onChange: onRemoteChange,
  });
  useRealtimeTable({
    table: "change_log_comments",
    filter: `tenantId=eq.${user.tenantId}`,
    onChange: onRemoteChange,
  });

  // A notification about a reply links to its post: `/change-log?post=<id>`.
  // Read once on the client rather than through useSearchParams, which would
  // put a Suspense boundary around the whole feed for one optional value.
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    setFocusId(new URLSearchParams(window.location.search).get("post"));
  }, []);
  useEffect(() => {
    if (!focusId || loading) return;
    document.getElementById(`post-${focusId}`)?.scrollIntoView({ block: "center" });
  }, [focusId, loading]);

  const shown = useMemo(
    () => (category === "all" ? posts : posts.filter((p) => p.category === category)),
    [posts, category]
  );
  const unread = posts.filter((p) => !p.readByMe).length;

  function patchPost(id: string, patch: Partial<Post>) {
    setData((prev) =>
      prev
        ? { ...prev, posts: prev.posts.map((p) => (p.id === id ? { ...p, ...patch } : p)) }
        : prev
    );
  }

  async function markRead(post: Post) {
    if (post.readByMe) return;
    markLocalWrite();
    patchPost(post.id, {
      readByMe: true,
      readBy: [...post.readBy, { userId: user.id, reader: { fullName: user.fullName } }],
    });
    try {
      await fetchJson(`/api/change-log/${post.id}/read`, { method: "POST" });
    } catch (err) {
      patchPost(post.id, { readByMe: false, readBy: post.readBy });
      toast.error(errorMessage(err));
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusyId(editing.id);
    markLocalWrite();
    try {
      const updated = await fetchJson<Post>(`/api/change-log/${editing.id}`, {
        method: "PATCH",
        body: { body: editing.body },
      });
      patchPost(editing.id, { body: updated.body, editedAt: updated.editedAt });
      setEditing(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function withdraw(post: Post) {
    if (!window.confirm("Withdraw this post? It stops showing in the feed.")) return;
    setBusyId(post.id);
    markLocalWrite();
    try {
      await fetchJson(`/api/change-log/${post.id}`, { method: "DELETE" });
      setData((prev) =>
        prev ? { ...prev, posts: prev.posts.filter((p) => p.id !== post.id) } : prev
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Change Log"
        description="What changed, who needs to know, and who has seen it."
      />

      {canPost && (
        <Composer
          onPosted={() => {
            markLocalWrite();
            void refetch();
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Select value={category} onValueChange={(v) => setCategory(v ?? "all")}>
          <SelectTrigger className="w-48">
            <SelectValue>
              {(v) => (v === "all" ? "Everything" : categoryLabel(String(v)))}
            </SelectValue>
          </SelectTrigger>
          {/* Menu-style: aligned to the trigger, not to the selected item, which
              opened the list upwards whenever a later category was chosen. */}
          <SelectContent alignItemWithTrigger={false} align="start">
            <SelectItem value="all">Everything</SelectItem>
            {CHANGE_LOG_CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {unread > 0 && <Badge variant="info">{unread} unread</Badge>}
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-destructive">
            {errorMessage(error)}
          </CardContent>
        </Card>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title={category === "all" ? "Nothing posted yet" : "Nothing in that category"}
          description={
            canPost
              ? "Post the next change that sales should hear about before a customer asks."
              : "When engineering posts a change, it appears here."
          }
        />
      ) : (
        <div className="space-y-6">
          {byDay(shown).map(({ day, posts: ofDay }) => (
            <section key={day} className="space-y-3">
              <div className="flex items-center gap-3">
                <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {day}
                </h2>
                <span aria-hidden className="h-px flex-1 bg-border" />
              </div>

              {ofDay.map((post) => {
                const author = personName(post.author) ?? "Someone";
                const isEditing = editing?.id === post.id;
                return (
                  <Card
                    key={post.id}
                    id={`post-${post.id}`}
                    className={cn(
                      post.readByMe ? undefined : "border-info/40",
                      post.id === focusId && "ring-2 ring-ring/40"
                    )}
                  >
                    <CardContent className="space-y-3 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Avatar size="sm">
                          <AvatarFallback className="text-2xs">{initials(author)}</AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-medium">{author}</span>
                        <CategoryMark category={post.category} />
                        <span className="text-xs text-muted-foreground">
                          <FormattedDate date={post.createdAt} variant="datetime" />
                        </span>
                        {post.editedAt && (
                          <span className="text-2xs text-muted-foreground italic">edited</span>
                        )}
                        {!post.readByMe && (
                          <Badge variant="info" className="ml-auto">
                            New
                          </Badge>
                        )}
                      </div>

                      {isEditing ? (
                        <div className="space-y-2">
                          <Textarea
                            value={editing.body}
                            rows={5}
                            onChange={(e) => setEditing({ id: post.id, body: e.target.value })}
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => void saveEdit()}
                              disabled={busyId === post.id}
                            >
                              Save
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <PostBody body={post.body} />
                      )}

                      {post.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {post.attachments.map((file) => (
                            <a
                              key={file.id}
                              href={`/api/change-log/attachments/${file.id}`}
                              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                            >
                              <Paperclip className="w-3 h-3" />
                              {file.fileName}
                              {file.sizeBytes ? (
                                <span className="text-muted-foreground">
                                  {fileSize(file.sizeBytes)}
                                </span>
                              ) : null}
                            </a>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Users className="w-3.5 h-3.5 shrink-0" />
                          {post.readBy.length === 0 ? (
                            "Nobody has marked this read"
                          ) : (
                            <>
                              <span className="flex -space-x-1.5">
                                {post.readBy.slice(0, 5).map((r) => (
                                  <Avatar
                                    key={r.userId}
                                    size="sm"
                                    title={personName(r.reader) ?? ""}
                                  >
                                    <AvatarFallback className="text-2xs">
                                      {initials(personName(r.reader))}
                                    </AvatarFallback>
                                  </Avatar>
                                ))}
                              </span>
                              <span>
                                Read by {post.readBy.length}
                                {post.readBy.length <= 3 &&
                                  ` — ${post.readBy
                                    .map((r) => personName(r.reader) ?? "someone")
                                    .join(", ")}`}
                              </span>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {post.authorId === user.id && !isEditing && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                aria-label="Edit this post"
                                onClick={() => setEditing({ id: post.id, body: post.body })}
                              >
                                <Pencil className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 text-destructive hover:text-destructive/80"
                                aria-label="Withdraw this post"
                                onClick={() => void withdraw(post)}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </>
                          )}
                          {post.readByMe ? (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <Check className="w-3.5 h-3.5" /> Read
                            </span>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => void markRead(post)}>
                              Mark as read
                            </Button>
                          )}
                        </div>
                      </div>

                      <CommentThread
                        postId={post.id}
                        comments={post.comments}
                        currentUserId={user.id}
                        currentUserName={user.fullName}
                        isAdmin={isAdmin}
                        onChange={(comments) => patchPost(post.id, { comments })}
                        onLocalWrite={markLocalWrite}
                      />
                    </CardContent>
                  </Card>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  );
}

/** Write a post, with a file if there is one. */
function Composer({ onPosted }: { onPosted: () => void }) {
  const [body, setBody] = useState("");
  const [category, setCategory] = useState<string>(DEFAULT_CATEGORY);
  const [files, setFiles] = useState<File[]>([]);
  const [posting, setPosting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || posting) return;
    setPosting(true);
    try {
      const post = await fetchJson<{ id: string }>("/api/change-log", {
        method: "POST",
        body: { body: body.trim(), category },
      });

      // Attachments follow the post: it has to exist before a file can hang
      // off it. A failed upload leaves the post — it is the words that matter.
      for (const file of files) {
        try {
          await uploadFile(`/api/change-log/${post.id}/attachments`, file);
        } catch (err) {
          toast.error(`${file.name}: ${errorMessage(err)}`);
        }
      }

      setBody("");
      setFiles([]);
      setCategory(DEFAULT_CATEGORY);
      if (fileInput.current) fileInput.current.value = "";
      toast.success("Posted — everyone has been told");
      onPosted();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPosting(false);
    }
  }

  return (
    <Card>
      <CardContent className="py-4">
        <form onSubmit={submit} className="space-y-3">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            className="resize-y border-0 px-0 shadow-none focus-visible:ring-0"
            placeholder="What changed, and what it means for a quote or an order in flight? One reason per line reads as a list."
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select value={category} onValueChange={(v) => setCategory(v ?? DEFAULT_CATEGORY)}>
              <SelectTrigger className="w-48">
                <SelectValue>{(v) => categoryLabel(String(v))}</SelectValue>
              </SelectTrigger>
              {/* The default category is the last in the list, and aligning the
                  popup to the selected item opened it upwards over the page
                  header. A composer's menu drops down. */}
              <SelectContent alignItemWithTrigger={false} align="start">
                {CHANGE_LOG_CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <input
              ref={fileInput}
              id="change-log-files"
              type="file"
              multiple
              className="hidden"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.xlsx,.docx"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
              <Paperclip className="w-4 h-4 mr-2" />
              Attach
            </Button>

            <div className="flex-1 min-w-0 flex flex-wrap gap-1.5">
              {files.map((file) => (
                <span
                  key={file.name}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs"
                >
                  {file.name}
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setFiles((prev) => prev.filter((f) => f.name !== file.name))}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>

            <Button type="submit" disabled={!body.trim() || posting}>
              {posting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Post
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
