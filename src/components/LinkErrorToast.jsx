import React, { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";

import { LINK_ERROR_EVENT } from "../native/externalLinks.js";

// Native shells cannot show the browser's popup-blocked UI, so every failed
// external open surfaces here instead of failing silently.
export default function LinkErrorToast() {
  const [message, setMessage] = useState("");

  useEffect(() => {
    function onError(event) {
      const detail = event?.detail;
      if (detail?.message) setMessage(String(detail.message));
    }
    window.addEventListener(LINK_ERROR_EVENT, onError);
    return () => window.removeEventListener(LINK_ERROR_EVENT, onError);
  }, []);

  return (
    <Snackbar
      open={Boolean(message)}
      autoHideDuration={7000}
      onClose={() => setMessage("")}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
    >
      <Alert severity="error" variant="filled" onClose={() => setMessage("")} sx={{ maxWidth: 520 }}>
        {message}
      </Alert>
    </Snackbar>
  );
}
