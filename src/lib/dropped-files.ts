/**
 * Reading what someone dropped onto the vault: loose files, whole folders, or
 * both.
 *
 * `dataTransfer.files` lists only the top-level files, and dropping a folder
 * put nothing usable in it — so a desktop drop uploaded only its first file,
 * and a dropped folder failed (AUD-003 VLT-6). Directory entries have to be
 * walked through the entries API instead.
 */

export interface DroppedFile {
  file: File;
  /** Folder names between the drop target and the file; empty for a loose file. */
  dir: string[];
}

/**
 * Files no one means to put in a vault: OS metadata, and the `~$` lock files
 * SolidWorks and Office leave next to an open document.
 */
export function isJunkFile(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name === "Thumbs.db" ||
    name === "desktop.ini" ||
    name.startsWith("~$") ||
    name.startsWith("._")
  );
}

/** Minimal shapes of the (non-standard but universally supported) entries API. */
interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface FileEntryLike extends EntryLike {
  file(success: (file: File) => void, failure?: (err: unknown) => void): void;
}
interface DirectoryEntryLike extends EntryLike {
  createReader(): {
    readEntries(success: (entries: EntryLike[]) => void, failure?: (err: unknown) => void): void;
  };
}

/**
 * Everything in a drop, folders walked, junk left out.
 *
 * The entries must be taken from the event synchronously — the DataTransfer
 * is emptied once the handler yields — so this reads them before its first
 * `await`. Call it directly inside the drop handler.
 */
export function readDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const entries = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() as EntryLike | null | undefined)
    .filter((entry): entry is EntryLike => Boolean(entry));

  if (entries.length === 0) {
    const files = Array.from(dataTransfer.files ?? []).map((file) => ({ file, dir: [] }));
    return Promise.resolve(files.filter((f) => !isJunkFile(f.file.name)));
  }
  return collectEntries(entries);
}

export async function collectEntries(entries: EntryLike[]): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const walk = async (entry: EntryLike, dir: string[]): Promise<void> => {
    if (entry.isFile) {
      if (isJunkFile(entry.name)) return;
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileEntryLike).file(resolve, reject)
      );
      out.push({ file, dir });
    } else if (entry.isDirectory) {
      for (const child of await readAllEntries(entry as DirectoryEntryLike)) {
        await walk(child, [...dir, entry.name]);
      }
    }
  };
  for (const entry of entries) await walk(entry, []);
  return out;
}

/** `readEntries` returns a batch at a time (100 in Chrome) until it returns none. */
async function readAllEntries(directory: DirectoryEntryLike): Promise<EntryLike[]> {
  const reader = directory.createReader();
  const all: EntryLike[] = [];
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}
