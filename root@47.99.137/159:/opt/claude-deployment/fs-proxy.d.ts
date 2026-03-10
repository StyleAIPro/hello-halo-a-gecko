import type { FileInfo } from './types.js';
export declare class FsProxy {
    private workDir;
    constructor(workDir?: string);
    private resolvePath;
    listDir(dirPath?: string): Promise<FileInfo[]>;
    readFile(filePath: string): Promise<string>;
    writeFile(filePath: string, content: string): Promise<void>;
    deleteFile(filePath: string): Promise<void>;
    uploadFile(filePath: string, content: Buffer): Promise<void>;
    downloadFile(filePath: string): Promise<Buffer>;
    setWorkDir(dir: string): void;
    getWorkDir(): string;
}
//# sourceMappingURL=fs-proxy.d.ts.map