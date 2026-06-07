"""
精简版 Repo Map 生成器

从 aider 的 repomap.py 提取核心逻辑，独立运行。
使用 tree-sitter 解析代码，提取函数/类/接口/type 定义的签名。

输入: CLI args: <repo_path> [max_tokens]
输出: JSON stdout {"map": "...", "tokens": N, "files_count": N}

依赖: pip install tree-sitter grep-ast tree-sitter-languages
"""

import sys
import json
import os
from pathlib import Path

try:
    from grep_ast import TreeContext, filename_to_lang
    from tree_sitter_languages import get_language, get_parser
    HAS_TREE_SITTER = True
except ImportError:
    HAS_TREE_SITTER = False


def get_repo_map(repo_path: str, max_tokens: int = 5000,
                 focus_files: list = None) -> dict:
    """生成仓库的结构骨架"""
    src_path = Path(repo_path) / "src"
    if not src_path.exists():
        src_path = Path(repo_path)

    extensions = {".ts", ".tsx", ".js", ".jsx", ".css"}
    all_files = []
    for ext in extensions:
        all_files.extend(src_path.rglob(f"*{ext}"))

    all_files = [f for f in all_files if "node_modules" not in str(f)]

    if not all_files:
        return {"map": "No source files found.", "tokens": 0, "files_count": 0}

    skeleton_lines = []
    total_tokens = 0

    for filepath in sorted(all_files):
        rel_path = filepath.relative_to(repo_path)
        lang = get_lang_for_file(str(filepath))
        if not lang:
            continue

        try:
            code = filepath.read_text(encoding="utf-8")

            if HAS_TREE_SITTER:
                definitions = extract_definitions_treesitter(code, lang)
            else:
                definitions = extract_definitions_regex(code)

            if definitions:
                skeleton_lines.append(f"\n## {rel_path}")
                for defn in definitions:
                    skeleton_lines.append(f"  {defn}")
                    total_tokens += len(defn) // 4

                if total_tokens >= max_tokens:
                    skeleton_lines.append(f"\n... (truncated at {max_tokens} tokens)")
                    break
        except Exception:
            continue

    map_text = "\n".join(skeleton_lines)
    return {
        "map": map_text,
        "tokens": total_tokens,
        "files_count": len(all_files),
    }


def get_lang_for_file(filepath: str) -> str:
    """获取文件对应的语言标识"""
    ext_map = {
        ".ts": "typescript",
        ".tsx": "tsx",
        ".js": "javascript",
        ".jsx": "javascript",
    }
    for ext, lang in ext_map.items():
        if filepath.endswith(ext):
            return lang
    return ""


def extract_definitions_treesitter(code: str, lang: str) -> list:
    """使用 tree-sitter 提取定义签名"""
    try:
        parser = get_parser(lang)
        tree = parser.parse(bytes(code, "utf-8"))
    except Exception:
        return extract_definitions_regex(code)

    definitions = []
    def_types = {
        "function_declaration",
        "method_definition",
        "class_declaration",
        "interface_declaration",
        "type_alias_declaration",
        "export_statement",
        "lexical_declaration",
    }

    def visit(node, depth=0):
        if depth > 3:
            return
        if node.type in def_types:
            first_line = code[node.start_byte:node.end_byte].split("\n")[0]
            if len(first_line) > 120:
                first_line = first_line[:120] + "..."
            # 过滤太短或无意义的行
            if len(first_line.strip()) > 10:
                definitions.append(first_line.strip())
        for child in node.children:
            visit(child, depth + 1)

    visit(tree.root_node)
    return definitions[:50]


def extract_definitions_regex(code: str) -> list:
    """降级方案：用正则提取定义"""
    import re
    definitions = []
    patterns = [
        r'^(export\s+(?:default\s+)?(?:async\s+)?function\s+\w+[^{]*)',
        r'^(export\s+(?:default\s+)?class\s+\w+[^{]*)',
        r'^(export\s+(?:interface|type)\s+\w+[^{=]*)',
        r'^(export\s+const\s+\w+)',
    ]

    for pattern in patterns:
        for match in re.finditer(pattern, code, re.MULTILINE):
            line = match.group(1).strip()
            if len(line) > 120:
                line = line[:120] + "..."
            if line not in definitions:
                definitions.append(line)

    return definitions[:30]


if __name__ == "__main__":
    if len(sys.argv) >= 2:
        repo_path = sys.argv[1]
        max_tokens = int(sys.argv[2]) if len(sys.argv) > 2 else 5000
        result = get_repo_map(repo_path, max_tokens)
        print(json.dumps(result, ensure_ascii=False))
    else:
        # Stdin JSON 模式
        try:
            input_data = json.loads(sys.stdin.read())
            result = get_repo_map(**input_data)
            print(json.dumps(result, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"map": f"Error: {e}", "tokens": 0, "files_count": 0}))
