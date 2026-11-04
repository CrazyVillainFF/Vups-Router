import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  DEFAULT_TAB,
  clampPanelWidth,
  isPanelTab,
  readPanelState,
  writePanelState
} from "./panelModel.js";

const PanelContext = createContext(null);

function area() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function PanelProvider({ children }) {
  const [state, setState] = useState(() => readPanelState(area()));

  const update = useCallback(patch => {
    setState(prev => {
      const next = { ...prev, ...patch };
      if ("width" in patch) next.width = clampPanelWidth(patch.width, window?.innerWidth);
      writePanelState(area(), next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      open: state.open,
      activeTab: state.activeTab || DEFAULT_TAB,
      width: state.width,
      toggle: () => update({ open: !state.open }),
      setOpen: next => update({ open: Boolean(next) }),
      selectTab: id => {
        if (isPanelTab(id)) update({ activeTab: id });
      },
      setWidth: width => update({ width })
    }),
    [state, update]
  );

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function usePanel() {
  const context = useContext(PanelContext);
  if (!context) throw new Error("usePanel must be used inside a PanelProvider.");
  return context;
}
