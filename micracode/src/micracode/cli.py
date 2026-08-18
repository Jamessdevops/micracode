"""Micracode CLI — ``micracode web`` starts the web app."""

from __future__ import annotations

import typer

app = typer.Typer(
    name="micracode",
    help="Micracode — AI-powered web app builder.",
    no_args_is_help=True,
)


@app.callback()
def _main() -> None:
    """Keep ``web`` a subcommand — Typer collapses single-command apps."""


@app.command()
def web(
    host: str = typer.Option("127.0.0.1", help="Bind host."),
    port: int = typer.Option(8000, help="Bind port."),
    reload: bool = typer.Option(False, help="Enable auto-reload (dev mode)."),
) -> None:
    """Start the Micracode web app."""
    import uvicorn

    uvicorn.run(
        "micracode.server:app",
        host=host,
        port=port,
        reload=reload,
    )


if __name__ == "__main__":
    app()
