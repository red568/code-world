/**
 * Memory 管理器（占位实现）
 *
 * 预留接口，当前不实现具体逻辑。
 * 未来扩展路径：KV 存储 → 向量搜索 → 自动记忆提取。
 */

import type { MemoryEntry, MemoryType } from "./types.js";

export interface IMemoryManager {
  save(entry: MemoryEntry): Promise<string>;
  retrieve(query: string, type?: MemoryType, limit?: number): Promise<MemoryEntry[]>;
  update(id: string, updates: Partial<MemoryEntry>): Promise<void>;
  delete(id: string): Promise<void>;
  list(type?: MemoryType): Promise<MemoryEntry[]>;
}

export class MemoryManager implements IMemoryManager {
  async save(_entry: MemoryEntry): Promise<string> {
    return "placeholder-id";
  }

  async retrieve(_query: string, _type?: MemoryType, _limit?: number): Promise<MemoryEntry[]> {
    return [];
  }

  async update(_id: string, _updates: Partial<MemoryEntry>): Promise<void> {}

  async delete(_id: string): Promise<void> {}

  async list(_type?: MemoryType): Promise<MemoryEntry[]> {
    return [];
  }
}
