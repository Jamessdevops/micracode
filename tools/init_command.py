"""
/init command implementation for codebase onboarding.
Analyzes the project structure and generates a Micracode.md handbook.
"""

import os
from pathlib import Path
from typing import Optional
from datetime import datetime

# Directories to exclude from scanning
EXCLUDED_DIRS = {
    ".venv", "venv", "env", ".env",
    "node_modules",
    ".git",
    "__pycache__", ".pytest_cache", ".mypy_cache",
    "dist", "build", ".build",
    ".next", ".nuxt",
    "target",  # Rust/Java
    ".idea", ".vscode",
    "coverage", ".coverage",
    ".tox", ".nox",
    "eggs", "*.egg-info",
    ".eggs",
}

# File extensions to exclude
EXCLUDED_EXTENSIONS = {
    ".pyc", ".pyo", ".pyd",
    ".so", ".dll", ".dylib",
    ".lock", ".log",
    ".ico", ".png", ".jpg", ".jpeg", ".gif", ".svg",
    ".woff", ".woff2", ".ttf", ".eot",
}


def should_exclude_dir(name: str) -> bool:
    """Check if a directory should be excluded."""
    return name in EXCLUDED_DIRS or name.startswith(".")


def should_exclude_file(name: str) -> bool:
    """Check if a file should be excluded."""
    ext = Path(name).suffix.lower()
    return ext in EXCLUDED_EXTENSIONS


def analyze_directory_structure(root_path: Path, max_depth: int = 3) -> str:
    """Generate a tree-like directory structure."""
    lines = []
    
    def walk(path: Path, prefix: str = "", depth: int = 0):
        if depth > max_depth:
            return
        
        try:
            entries = sorted(path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
        except PermissionError:
            return
        
        dirs = [e for e in entries if e.is_dir() and not should_exclude_dir(e.name)]
        files = [e for e in entries if e.is_file() and not should_exclude_file(e.name)]
        
        all_entries = dirs + files
        
        for i, entry in enumerate(all_entries):
            is_last = i == len(all_entries) - 1
            connector = "└── " if is_last else "├── "
            
            if entry.is_dir():
                lines.append(f"{prefix}{connector}{entry.name}/")
                extension = "    " if is_last else "│   "
                walk(entry, prefix + extension, depth + 1)
            else:
                lines.append(f"{prefix}{connector}{entry.name}")
    
    lines.append(f"{root_path.name}/")
    walk(root_path)
    
    return "\n".join(lines)


def detect_tech_stack(root_path: Path) -> dict:
    """Detect the technology stack from config files."""
    stack = {
        "languages": set(),
        "frameworks": set(),
        "dependencies": [],
        "tools": set(),
    }
    
    # Check for Python
    pyproject = root_path / "pyproject.toml"
    requirements = root_path / "requirements.txt"
    setup_py = root_path / "setup.py"
    
    if pyproject.exists():
        stack["languages"].add("Python")
        stack["tools"].add("pyproject.toml (modern Python packaging)")
        try:
            content = pyproject.read_text()
            if "textual" in content.lower():
                stack["frameworks"].add("Textual (TUI framework)")
            if "langgraph" in content.lower():
                stack["frameworks"].add("LangGraph (AI agent framework)")
            if "langchain" in content.lower():
                stack["frameworks"].add("LangChain (LLM toolkit)")
            if "uv" in content.lower() or (root_path / "uv.lock").exists():
                stack["tools"].add("uv (package manager)")
        except Exception:
            pass
    
    if requirements.exists():
        stack["languages"].add("Python")
        
    if setup_py.exists():
        stack["languages"].add("Python")
    
    # Check for JavaScript/Node
    package_json = root_path / "package.json"
    if package_json.exists():
        stack["languages"].add("JavaScript/TypeScript")
        try:
            import json
            content = json.loads(package_json.read_text())
            deps = {**content.get("dependencies", {}), **content.get("devDependencies", {})}
            if "react" in deps:
                stack["frameworks"].add("React")
            if "next" in deps:
                stack["frameworks"].add("Next.js")
            if "vue" in deps:
                stack["frameworks"].add("Vue.js")
        except Exception:
            pass
    
    # Check for common files
    if (root_path / "Cargo.toml").exists():
        stack["languages"].add("Rust")
    if (root_path / "go.mod").exists():
        stack["languages"].add("Go")
    if (root_path / "pom.xml").exists():
        stack["languages"].add("Java (Maven)")
    if (root_path / "build.gradle").exists():
        stack["languages"].add("Java/Kotlin (Gradle)")
    
    return stack


def find_key_files(root_path: Path) -> list[dict]:
    """Identify key files in the project."""
    key_files = []
    
    # Common entry points and important files
    important_patterns = {
        "main.py": "Main application entry point",
        "app.py": "Application entry point",
        "test.py": "Test/development entry point",
        "index.py": "Main module",
        "index.js": "JavaScript entry point",
        "index.ts": "TypeScript entry point",
        "README.md": "Project documentation",
        "pyproject.toml": "Python project configuration",
        "package.json": "Node.js project configuration",
        ".gitignore": "Git ignore rules",
    }
    
    for pattern, description in important_patterns.items():
        file_path = root_path / pattern
        if file_path.exists():
            key_files.append({
                "name": pattern,
                "description": description,
                "path": str(file_path.relative_to(root_path)),
            })
    
    return key_files


def analyze_code_patterns(root_path: Path) -> list[str]:
    """Detect common code patterns and conventions."""
    patterns = []
    
    # Check for component-based architecture
    if (root_path / "component").is_dir() or (root_path / "components").is_dir():
        patterns.append("Component-based architecture")
    
    # Check for tools/plugins pattern
    if (root_path / "tools").is_dir():
        patterns.append("Tools/plugins pattern for extensibility")
    
    # Check for agent pattern
    if (root_path / "agent").is_dir():
        patterns.append("AI agent architecture")
    
    # Check for config separation
    if (root_path / "config").is_dir():
        patterns.append("Configuration separated from code")
    
    # Check for LLM integration
    if (root_path / "llm").is_dir():
        patterns.append("LLM integration layer")
    
    # Check for tests
    if (root_path / "tests").is_dir() or (root_path / "test").is_dir():
        patterns.append("Test directory structure")
    
    return patterns


def read_readme(root_path: Path) -> Optional[str]:
    """Extract overview from README if available."""
    readme = root_path / "README.md"
    if readme.exists():
        try:
            content = readme.read_text()
            # Get first meaningful paragraph
            lines = content.split("\n")
            for i, line in enumerate(lines):
                if line.strip() and not line.startswith("#"):
                    # Return a few lines as overview
                    overview_lines = []
                    for l in lines[i:i+5]:
                        if l.strip():
                            overview_lines.append(l.strip())
                        else:
                            break
                    return " ".join(overview_lines)[:500]
        except Exception:
            pass
    return None


def generate_Micracode_md(root_path: Path) -> str:
    """Generate the content for Micracode.md."""
    # Resolve to absolute path to get correct project name
    abs_path = root_path.resolve()
    project_name = abs_path.name
    
    # Gather information
    structure = analyze_directory_structure(root_path)
    tech_stack = detect_tech_stack(root_path)
    key_files = find_key_files(root_path)
    patterns = analyze_code_patterns(root_path)
    readme_overview = read_readme(root_path)
    
    # Build the markdown content
    lines = [
        f"# {project_name} - AI Handbook",
        "",
        f"*Generated by Micracode on {datetime.now().strftime('%Y-%m-%d %H:%M')}*",
        "",
        "---",
        "",
    ]
    
    # Overview section
    lines.append("## Overview")
    lines.append("")
    if readme_overview:
        lines.append(readme_overview)
    else:
        lines.append(f"This is the {project_name} project.")
    lines.append("")
    
    # Tech Stack section
    lines.append("## Tech Stack")
    lines.append("")
    if tech_stack["languages"]:
        lines.append(f"**Languages:** {', '.join(sorted(tech_stack['languages']))}")
    if tech_stack["frameworks"]:
        lines.append(f"**Frameworks:** {', '.join(sorted(tech_stack['frameworks']))}")
    if tech_stack["tools"]:
        lines.append(f"**Tools:** {', '.join(sorted(tech_stack['tools']))}")
    lines.append("")
    
    # Directory Structure section
    lines.append("## Directory Structure")
    lines.append("")
    lines.append("```")
    lines.append(structure)
    lines.append("```")
    lines.append("")
    
    # Key Files section
    if key_files:
        lines.append("## Key Files")
        lines.append("")
        for f in key_files:
            lines.append(f"- **`{f['name']}`** - {f['description']}")
        lines.append("")
    
    # Code Patterns section
    if patterns:
        lines.append("## Architecture & Patterns")
        lines.append("")
        for p in patterns:
            lines.append(f"- {p}")
        lines.append("")
    
    # Guidelines section (placeholder for user to fill)
    lines.append("## Guidelines")
    lines.append("")
    lines.append("*Add your project-specific conventions and rules here.*")
    lines.append("")
    lines.append("- Code style: ...")
    lines.append("- Naming conventions: ...")
    lines.append("- Testing requirements: ...")
    lines.append("")
    
    return "\n".join(lines)


def run_init_command(root_path: Optional[str] = None) -> str:
    """
    Execute the /init command to generate Micracode.md.
    
    Args:
        root_path: Path to project root. Defaults to current directory.
    
    Returns:
        Result message string.
    """
    if root_path is None:
        root_path = os.getcwd()
    
    path = Path(root_path)
    
    if not path.is_dir():
        return f"Error: {root_path} is not a valid directory."
    
    try:
        content = generate_Micracode_md(path)
        output_file = path / "Micracode.md"
        output_file.write_text(content)
        return f"✓ Created Micracode.md in {path}"
    except Exception as e:
        return f"Error generating Micracode.md: {str(e)}"
