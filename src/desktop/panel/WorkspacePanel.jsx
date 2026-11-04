import React, { useCallback, useEffect, useRef } from "react";
import { FolderOpen, GitBranch, Terminal, Globe, ListChecks } from "@phosphor-icons/react";
import { detectNativeShell } from "../../native/shell.js";
import { usePanel } from "./PanelContext.jsx";
import { PANEL_TABS, clampPanelWidth } from "./panelModel.js";
import PanelShell from "./PanelShell.jsx";
import FilesPane from "./FilesPane.jsx";
import ReviewPane from "./ReviewPane.jsx";
import TerminalPane from "./TerminalPane.jsx";
import BrowserPane from "./BrowserPane.jsx";
import SideTaskPane from "./SideTaskPane.jsx";
import "./workspacePanel.css";

const TAB_ICONS = {
  files: FolderOpen,
  review: GitBranch,
  terminal: Terminal,
  browser: Globe,
  "side-task": ListChecks
};

const PANES = {
  files: <FilesPane />,
  review: <ReviewPane />,
  terminal: <TerminalPane />,
  browser: <BrowserPane />,
  "side-task": <SideTaskPane />
};

export default function WorkspacePanel() {
  const { open, activeTab, width, toggle, selectTab, setWidth } = usePanel();
  const drag = useRef(null);

  const onResizeStart = useCallback(
    event => {
      event.preventDefault();
      drag.current = { startX: event.clientX, startWidth: width };
      const onMove = moveEvent => {
        const delta = drag.current.startX - moveEvent.clientX;
        setWidth(clampPanelWidth(drag.current.startWidth + delta, window.innerWidth));
      };
      const onUp = () => {
        drag.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, setWidth]
  );

  useEffect(() => {
    const onKey = event => {
      if (!open || document.activeElement?.getAttribute?.("aria-label") !== "Resize workspace panel") return;
      if (event.key === "ArrowLeft") setWidth(clampPanelWidth(width + 24, window.innerWidth));
      if (event.key === "ArrowRight") setWidth(clampPanelWidth(width - 24, window.innerWidth));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, width, setWidth]);

  // The workspace panel is a Windows-shell feature; it must not appear on web
  // or Android, whose native commands are unavailable.
  if (detectNativeShell() !== "windows") return null;

  return (
    <PanelShell
      open={open}
      tabs={PANEL_TABS}
      activeTab={activeTab}
      width={width}
      icons={TAB_ICONS}
      panes={PANES}
      onToggle={toggle}
      onSelectTab={selectTab}
      onResizeStart={onResizeStart}
    />
  );
}
