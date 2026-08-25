/**
 * Putting a file on the user's disk, by whichever route the browser offers.
 *
 * There are two, and they are not equivalent. `showSaveFilePicker` is a real
 * Save-As dialog: the user names the file and chooses the folder, which is what
 * saving normally means. Everywhere it is missing, the only route is an
 * `<a download>` click, which drops the file into the download folder under a
 * name the page suggests and gives the user no say in either. So the result says
 * which one happened rather than reporting a bare success — "saved" and "sent to
 * your downloads" are different enough that the user should not have to guess.
 *
 * Cancelling is not failing. The picker rejects with an `AbortError` when the
 * user closes it, and reporting that as an error would put a red notice on
 * screen for someone who simply changed their mind.
 */

/**
 * The File System Access API. TypeScript's DOM library does not declare it (it
 * is not on the standards track in every engine), so the shape used here is
 * declared rather than cast away — a wrong assumption then fails to compile
 * instead of failing at the moment someone tries to save.
 */
interface FileSystemWritable {
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
}
interface SaveFileHandle {
  readonly name: string;
  createWritable(): Promise<FileSystemWritable>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type SaveFilePicker = (options: SaveFilePickerOptions) => Promise<SaveFileHandle>;

export type SaveOutcome =
  /** The user chose a name and a folder, and the file is there. */
  | { kind: 'saved'; name: string }
  /** No picker in this browser; the file went to the download folder. */
  | { kind: 'downloaded'; name: string }
  /** The user closed the dialog. Nothing was written and nothing went wrong. */
  | { kind: 'canceled' };

export interface SaveTextOptions {
  /** The name to offer in the dialog, extension included. */
  suggestedName: string;
  /** What the dialog calls this kind of file. */
  description: string;
  /** MIME type mapped to its extensions, e.g. `{'text/plain': ['.zmx']}`. */
  accept: Record<string, string[]>;
  /**
   * The window the click came from. Anything reaching for `window` has to take
   * the one it is in: a panel sent to the second window lives in another realm,
   * and a picker opened against the opener would be the wrong window's dialog.
   */
  target?: Window;
}

/** Writes text to a file the user names, or to their downloads if that is all the browser has. */
export async function saveTextToFile(
  text: string,
  { suggestedName, description, accept, target = window }: SaveTextOptions,
): Promise<SaveOutcome> {
  const picker = (target as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;

  if (typeof picker === 'function') {
    let handle: SaveFileHandle;
    try {
      handle = await picker.call(target, {
        suggestedName,
        types: [{ description, accept }],
      });
    } catch (error) {
      if (isAbort(error)) {
        return { kind: 'canceled' };
      }
      throw error;
    }
    // Outside the catch above on purpose: a failure to *write* is a real
    // failure, and swallowing it here would report a save that did not happen.
    const writable = await handle.createWritable();
    try {
      await writable.write(text);
    } finally {
      await writable.close();
    }
    return { kind: 'saved', name: handle.name };
  }

  download(text, suggestedName, target);
  return { kind: 'downloaded', name: suggestedName };
}

/** True for the rejection a picker gives when the user closes it. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function download(text: string, name: string, target: Window): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const anchor = target.document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  target.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * A system's name turned into a filename.
 *
 * Lens names are prose — "A SIMPLE DOUBLET USING A CROWN AND A FLINT." — so the
 * separators and punctuation a filesystem objects to are collapsed rather than
 * dropped, keeping the words readable. Only a *suggestion*: the user renames it
 * in the dialog if they like.
 */
export function suggestedFileName(name: string, extension: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80)
    // After the slice, not before: a long name can be cut mid-word and leave the
    // separator dangling, so a file called `long-name-.zmx` comes out otherwise.
    .replace(/[.-]+$/, '');
  return `${cleaned === '' ? 'system' : cleaned}${extension}`;
}
