import { promises as fs } from 'fs';
import path from 'path';
export class FsProxy {
    workDir;
    constructor(workDir = process.cwd()) {
        this.workDir = workDir;
    }
    resolvePath(relPath) {
        const resolvedPath = path.resolve(this.workDir, relPath);
        if (!resolvedPath.startsWith(this.workDir)) {
            throw new Error('Access denied: Path outside working directory');
        }
        return resolvedPath;
    }
    async listDir(dirPath = '') {
        const resolvedPath = this.resolvePath(dirPath);
        try {
            const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
            const fileInfos = [];
            for (const entry of entries) {
                const fullPath = path.join(resolvedPath, entry.name);
                const stats = await fs.stat(fullPath);
                fileInfos.push({
                    name: entry.name,
                    isDirectory: entry.isDirectory(),
                    size: stats.size,
                    modifiedTime: stats.mtime
                });
            }
            return fileInfos;
        }
        catch (error) {
            throw new Error(`Failed to list directory: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async readFile(filePath) {
        const resolvedPath = this.resolvePath(filePath);
        try {
            const content = await fs.readFile(resolvedPath, 'utf-8');
            return content;
        }
        catch (error) {
            throw new Error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async writeFile(filePath, content) {
        const resolvedPath = this.resolvePath(filePath);
        try {
            const dirPath = path.dirname(resolvedPath);
            await fs.mkdir(dirPath, { recursive: true });
            await fs.writeFile(resolvedPath, content, 'utf-8');
        }
        catch (error) {
            throw new Error(`Failed to write file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async deleteFile(filePath) {
        const resolvedPath = this.resolvePath(filePath);
        try {
            const stats = await fs.stat(resolvedPath);
            if (stats.isDirectory()) {
                await fs.rm(resolvedPath, { recursive: true, force: true });
            }
            else {
                await fs.unlink(resolvedPath);
            }
        }
        catch (error) {
            throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async uploadFile(filePath, content) {
        const resolvedPath = this.resolvePath(filePath);
        try {
            const dirPath = path.dirname(resolvedPath);
            await fs.mkdir(dirPath, { recursive: true });
            await fs.writeFile(resolvedPath, content);
        }
        catch (error) {
            throw new Error(`Failed to upload file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async downloadFile(filePath) {
        const resolvedPath = this.resolvePath(filePath);
        try {
            const content = await fs.readFile(resolvedPath);
            return content;
        }
        catch (error) {
            throw new Error(`Failed to download file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    setWorkDir(dir) {
        this.workDir = path.resolve(dir);
    }
    getWorkDir() {
        return this.workDir;
    }
}
//# sourceMappingURL=fs-proxy.js.map