import { constants } from "node:fs";
import {
	access,
	copyFile,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SettingsFile } from "../../settings/application";

const KEEP_BACKUPS = 20;

/**
 * settings.yml on disk. Writes go to a temporary file in the same folder and
 * are renamed into place, so a crash never leaves a half-written file; a
 * lock file serialises writers (the editor, the app registration...).
 */
export class FsSettingsFile implements SettingsFile {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		readonly path: string,
		private readonly backupsDir = join(dirname(path), "backups"),
	) {}

	async exists(): Promise<boolean> {
		try {
			await stat(this.path);
			return true;
		} catch {
			return false;
		}
	}

	read(): Promise<string> {
		return readFile(this.path, "utf8");
	}

	async isWritable(): Promise<boolean> {
		try {
			await access(this.path, constants.W_OK);
			await access(dirname(this.path), constants.W_OK);
			return true;
		} catch {
			return false;
		}
	}

	async backup(label: string): Promise<string | null> {
		if (!(await this.exists())) return null;
		await mkdir(this.backupsDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const name = `${basename(this.path).replace(/\.ya?ml$/, "")}.${stamp}.${label.replace(/[^A-Za-z0-9-]/g, "_")}.yml`;
		const target = join(this.backupsDir, name);
		await copyFile(this.path, target);
		const all = (await readdir(this.backupsDir))
			.filter((f) => f.endsWith(".yml"))
			.sort();
		for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS)))
			await rm(join(this.backupsDir, old), { force: true });
		return target;
	}

	async write(text: string): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const tmp = join(
			dirname(this.path),
			`.${basename(this.path)}.${process.pid}.tmp`,
		);
		let mode = 0o644;
		try {
			mode = (await stat(this.path)).mode & 0o777;
		} catch {
			/* new file */
		}
		const fh = await open(tmp, "w", mode);
		try {
			await fh.writeFile(text, "utf8");
			await fh.sync();
		} finally {
			await fh.close();
		}
		await rename(tmp, this.path);
	}

	/** In-process queue plus an exclusive lock file for other processes (CLI). */
	withLock<T>(work: () => Promise<T>): Promise<T> {
		const next = this.queue.then(() => this.lockFile(work));
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async lockFile<T>(work: () => Promise<T>): Promise<T> {
		const lock = `${this.path}.lock`;
		await mkdir(dirname(this.path), { recursive: true });
		for (let i = 0; ; i++) {
			try {
				const fh = await open(lock, "wx");
				await fh.writeFile(String(process.pid));
				await fh.close();
				break;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
				const age =
					Date.now() -
					(await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
				if (age > 30_000) {
					await unlink(lock).catch(() => undefined); // stale lock
					continue;
				}
				if (i > 100) throw new Error(`settings file is locked (${lock})`);
				await new Promise((r) => setTimeout(r, 50));
			}
		}
		try {
			return await work();
		} finally {
			await unlink(lock).catch(() => undefined);
		}
	}
}
