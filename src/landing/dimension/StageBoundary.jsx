import React from "react";

/* The 3D stage is spectacle with a real static composition already waiting on
   the page, so a scene that throws must never take the document down with it.
   Without this boundary an error raised inside the canvas unmounts the whole
   React tree and the reader is left with a black page and no way to sign in. */

export default class StageBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    this.props.onFail?.(error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
