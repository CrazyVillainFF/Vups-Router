import React from "react";
import { X } from "@phosphor-icons/react";

export default function PanelShell({
  open,
  tabs,
  activeTab,
  width,
  icons,
  panes,
  onToggle,
  onSelectTab,
  onResizeStart
}) {
  if (!open) {
    return (
      <button
        type="button"
        className="vr-panel-rail"
        onClick={onToggle}
        aria-label="Open workspace panel"
        aria-expanded={false}
      >
        <span className="vr-panel-rail__glyph" aria-hidden="true">
          {(icons[tabs[0]?.id] ? React.createElement(icons[tabs[0].id], { size: 16 }) : null)}
        </span>
        <span className="vr-panel-rail__text">Workspace</span>
      </button>
    );
  }

  return (
    <aside
      className="vr-workspace-panel"
      style={{ "--vr-panel-width": `${width}px` }}
      aria-label="Workspace panel"
    >
      <div
        className="vr-panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace panel"
        tabIndex={0}
        onPointerDown={onResizeStart}
      />
      <header className="vr-panel-head">
        <div className="vr-panel-tabs" role="tablist" aria-label="Workspace tools">
          {tabs.map(tab => {
            const Icon = icons[tab.id];
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`vr-tab-${tab.id}`}
                aria-controls={`vr-panel-${tab.id}`}
                aria-selected={selected}
                data-active={selected ? "" : undefined}
                className="vr-panel-tab"
                title={tab.label}
                onClick={() => onSelectTab(tab.id)}
              >
                {Icon ? <Icon size={15} aria-hidden="true" /> : null}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="vr-icon-btn"
          onClick={onToggle}
          aria-label="Close workspace panel"
          aria-expanded
        >
          <X size={16} />
        </button>
      </header>

      <div className="vr-panel-body">
        {tabs.map(tab => (
          <div
            key={tab.id}
            role="tabpanel"
            id={`vr-panel-${tab.id}`}
            aria-labelledby={`vr-tab-${tab.id}`}
            className="vr-panel-pane"
            // Every pane stays mounted; only the active one is shown, so a
            // terminal session, a loaded page, or a half-typed filter survives
            // switching tabs.
            hidden={activeTab !== tab.id}
          >
            {panes[tab.id]}
          </div>
        ))}
      </div>
    </aside>
  );
}
