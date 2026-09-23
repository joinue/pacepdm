"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FormattedDate } from "@/components/ui/formatted-date";
import { MentionInput } from "@/components/ui/mention-input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { COMMENT_MAX_LENGTH } from "@/lib/change-log";
import { initials, personName, type Person } from "./people";

/**
 * The thread under a post: where "does this affect the order in flight?" is
 * asked and answered next to the change, instead of in a reply to the
 * notification email that only one inbox ever sees.
 *
 * Always open, never collapsed: a thread behind a click is one nobody reads,
 * and the point of keeping the answer here is that the next person with the
 * question finds it. The reply box is one line until there is something in
 * it, so a feed of twenty posts is not a feed of twenty text areas.
 */

export interface Comment {
  id: string;
  postId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  authorId: string | null;
  author: Person;
}

interface CommentThreadProps {
  postId: string;
  comments: Comment[];
  currentUserId: string;
  currentUserName: string;
  /** Admins can withdraw anyone's reply, as they can anyone's post. */
  isAdmin: boolean;
  /** The thread as it now reads. The caller patches the post it belongs to. */
  onChange: (comments: Comment[]) => void;
  /** Tell the realtime echo guard that the next change on the table is ours. */
  onLocalWrite: () => void;
}

export function CommentThread({
  postId,
  comments,
  currentUserId,
  currentUserName,
  isAdmin,
  onChange,
  onLocalWrite,
}: CommentThreadProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const tooLong = draft.length > COMMENT_MAX_LENGTH;

  async function reply(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending || tooLong) return;
    setSending(true);
    onLocalWrite();
    try {
      const saved = await fetchJson<Comment>(`/api/change-log/${postId}/comments`, {
        method: "POST",
        body: { body: text },
      });
      onChange([...comments, { ...saved, author: saved.author ?? { fullName: currentUserName } }]);
      setDraft("");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function saveEdit() {
    if (!editing || !editing.body.trim()) return;
    setBusyId(editing.id);
    onLocalWrite();
    try {
      const updated = await fetchJson<Comment>(
        `/api/change-log/${postId}/comments/${editing.id}`,
        { method: "PATCH", body: { body: editing.body } }
      );
      onChange(
        comments.map((c) =>
          c.id === editing.id ? { ...c, body: updated.body, editedAt: updated.editedAt } : c
        )
      );
      setEditing(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function withdraw(comment: Comment) {
    if (!window.confirm("Withdraw this reply? It stops showing in the thread.")) return;
    setBusyId(comment.id);
    onLocalWrite();
    try {
      await fetchJson(`/api/change-log/${postId}/comments/${comment.id}`, { method: "DELETE" });
      onChange(comments.filter((c) => c.id !== comment.id));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-3">
      {comments.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MessageSquare className="w-3.5 h-3.5" aria-hidden />
          {comments.length} {comments.length === 1 ? "reply" : "replies"}
        </p>
      )}

      {comments.length > 0 && (
        <ul className="space-y-3">
          {comments.map((comment) => {
            const name = personName(comment.author) ?? "Someone";
            const own = comment.authorId === currentUserId;
            const isEditing = editing?.id === comment.id;
            return (
              <li key={comment.id} className="flex gap-2.5">
                <Avatar size="sm" className="mt-0.5">
                  <AvatarFallback className="text-2xs">{initials(name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                    <span className="font-medium text-foreground">{name}</span>
                    <span className="text-muted-foreground">
                      <FormattedDate date={comment.createdAt} variant="datetime" />
                    </span>
                    {comment.editedAt && (
                      <span className="text-2xs text-muted-foreground italic">edited</span>
                    )}
                    {(own || isAdmin) && !isEditing && (
                      <span className="ml-auto flex items-center gap-0.5">
                        {own && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            aria-label="Edit this reply"
                            disabled={busyId === comment.id}
                            onClick={() => setEditing({ id: comment.id, body: comment.body })}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-destructive hover:text-destructive/80"
                          aria-label="Withdraw this reply"
                          disabled={busyId === comment.id}
                          onClick={() => void withdraw(comment)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </span>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="space-y-2">
                      <Textarea
                        value={editing.body}
                        rows={3}
                        aria-label="Edit reply"
                        onChange={(e) => setEditing({ id: comment.id, body: e.target.value })}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => void saveEdit()}
                          disabled={busyId === comment.id || !editing.body.trim()}
                        >
                          Save
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={reply} className="flex items-start gap-2.5">
        <Avatar size="sm" className="mt-0.5">
          <AvatarFallback className="text-2xs">{initials(currentUserName)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 space-y-2">
          <MentionInput
            id={`reply-${postId}`}
            value={draft}
            onChange={setDraft}
            rows={1}
            placeholder="Reply — use @ to bring someone in"
            className="min-h-9 py-1.5 text-sm"
          />
          {draft.trim() && (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={sending || tooLong}>
                {sending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
                Reply
              </Button>
              <span
                className={tooLong ? "text-2xs text-destructive" : "text-2xs text-muted-foreground"}
              >
                {tooLong
                  ? `${draft.length - COMMENT_MAX_LENGTH} characters over the limit`
                  : "The author and everyone in this thread are told"}
              </span>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
