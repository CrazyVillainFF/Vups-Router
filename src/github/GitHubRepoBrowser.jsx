import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  ArrowsClockwise,
  ArrowSquareOut,
  CaretLeft,
  CaretRight,
  CircleNotch,
  FileText,
  FolderSimple,
  GitBranch,
  ListBullets,
  MagnifyingGlass,
  Plugs,
  WarningCircle,
  X
} from "@phosphor-icons/react";
import { executePluginTool, listPlugins, startPluginOAuth, uninstallPlugin } from "../services/api.js";
import { openExternalUrl } from "../native/externalLinks.js";
import {
  EMPTY_HISTORY,
  README_CANDIDATES,
  displayName,
  errorState,
  filterRepos,
  githubCard,
  goBack,
  goForward,
  ownerRepoFrom,
  pushView,
  repoLabel,
  resolveConnection,
  sortEntries
} from "./githubBrowser.js";
import "./GitHubRepoBrowser.css";

/* A real repository browser over the tools the backend already exposes:
   list_repositories, search_repositories, list_files, read_file and
   list_branches. Nothing here is simulated. Every row, directory and file body
   is an answer GitHub gave, and every failure keeps GitHub's own reason instead
   of a generic "something went wrong". */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function toRepo(entry) {
  if (!entry) return null;
  const source = entry.repository && typeof entry.repository === "object" ? entry.repository : entry;
  const owner = source.owner?.login || source.owner || entry.owner?.login || entry.owner || "";
  const name = source.name || entry.name || "";
  if (!owner || !name) return null;
  return {
    fullName: source.full_name || source.fullName || `${owner}/${name}`,
    owner,
    name,
    description: source.description || "",
    defaultBranch: source.default_branch || source.defaultBranch || "",
    private: Boolean(source.private),
    visibility: source.visibility || (source.private ? "private" : "public"),
    url: source.html_url || source.url || ""
  };
}

function reposFrom(result) {
  const list = Array.isArray(result?.repositories)
    ? result.repositories
    : Array.isArray(result?.items)
      ? result.items
      : Array.isArray(result?.results)
        ? result.results
        : Array.isArray(result)
          ? result
          : [];
  return list.map(toRepo).filter(Boolean);
}

function Row({ label, hint, onClick, icon: Icon }) {
  return (
    <button type="button" className="vr-ghb__row" onClick={onClick}>
      <span className="vr-ghb__row-icon" aria-hidden="true">
        {Icon ? <Icon size={15} weight="regular" /> : null}
      </span>
      <span className="vr-ghb__row-main">
        <span className="vr-ghb__row-label">{label}</span>
        {hint ? <span className="vr-ghb__row-hint">{hint}</span> : null}
      </span>
      <CaretRight className="vr-ghb__row-caret" size={14} weight="bold" aria-hidden="true" />
    </button>
  );
}

const NOTICE_COPY = {
  not_connected: {
    title: "GitHub is not connected",
    body: "Sign in with GitHub, or save an access token in Extensions. Public repositories can still be opened without either."
  },
  attention: {
    title: "GitHub needs your attention",
    body: "GitHub rejected the saved connection, so this list cannot be read until you connect again."
  },
  revoked: {
    title: "GitHub refused the credential",
    body: "The token or sign-in was revoked or has expired. Reconnect to keep browsing."
  },
  rate_limited: {
    title: "GitHub is rate-limiting this credential",
    body: "The API quota is used up for the moment. Wait for the reset, or connect with a token of your own."
  },
  forbidden: {
    title: "GitHub says this is not allowed",
    body: "The connection is missing a permission scope for this request. Reconnect with access to your repositories."
  },
  no_token: {
    title: "A GitHub credential is required",
    body: "This read needs a token. Connect GitHub in Extensions to open your own repositories."
  },
  not_found: {
    title: "GitHub did not return this",
    body: "The path or branch does not exist. A private repository you cannot see is answered the same way, so this may be a permissions question rather than a missing file."
  },
  offline: {
    title: "The request did not reach GitHub",
    body: "You appear to be offline, or the VupsRouter backend could not be reached."
  },
  cancelled: { title: "Reading stopped", body: "The request was cancelled before GitHub answered." },
  failed: { title: "GitHub could not answer", body: "The request failed. Try again in a moment." }
};

const FIXABLE = ["revoked", "attention", "forbidden", "not_connected"];

function Notice({ state, onRetry, onReconnect, onManage }) {
  const text = NOTICE_COPY[state?.key] || NOTICE_COPY.failed;
  const canFix = FIXABLE.includes(state?.key) || state?.key === "no_token";
  return (
    <div className="vr-ghb__notice" role="alert">
      <WarningCircle className="vr-ghb__notice-icon" size={18} weight="duotone" aria-hidden="true" />
      <div className="vr-ghb__notice-body">
        <h3>{text.title}</h3>
        <p>{text.body}</p>
        {state?.message ? <p className="vr-ghb__notice-detail">{state.message}</p> : null}
      </div>
      <div className="vr-ghb__notice-actions">
        <button type="button" className="vr-ghb__ghost" onClick={onRetry}>
          <ArrowsClockwise size={14} aria-hidden="true" />
          Try again
        </button>
        {canFix && state?.key !== "no_token" ? (
          <button type="button" className="vr-ghb__primary" onClick={onReconnect}>
            <Plugs size={14} aria-hidden="true" />
            Reconnect
          </button>
        ) : null}
        {canFix ? (
          <button type="button" className="vr-ghb__ghost" onClick={onManage}>
            Open Extensions
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function GitHubRepoBrowser({ open, onClose, onScope, onManage, initialRepo = null }) {
  const dialogRef = useRef(null);
  const returnFocus = useRef(null);
  const searchRef = useRef(null);
  const requestSeq = useRef(0);

  const [connection, setConnection] = useState(null);
  const [history, setHistory] = useState(EMPTY_HISTORY);
  const [repos, setRepos] = useState([]);
  const [branches, setBranches] = useState([]);
  const [entries, setEntries] = useState({ folders: [], files: [] });
  const [truncated, setTruncated] = useState(false);
  const [file, setFile] = useState(null);
  const [readme, setReadme] = useState(null);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(0);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const view = history.present;
  const connected = connection?.state === "token" || connection?.state === "oauth";

  const beginRead = useCallback(() => {
    requestSeq.current += 1;
    return requestSeq.current;
  }, []);

  async function readConnection() {
    const body = await listPlugins();
    const plugins = Array.isArray(body?.plugins) ? body.plugins : Array.isArray(body) ? body : [];
    return { card: githubCard(plugins), connection: resolveConnection(plugins) };
  }

  /* A slower answer must never overwrite a newer one: an in-flight read is
     dropped as soon as another view has been asked for. */
  async function call(tool, args, pluginId) {
    const id = pluginId || connection?.pluginId;
    if (!id) throw new Error("GitHub is not connected.");
    const response = await executePluginTool(id, tool, args);
    return response?.result ?? {};
  }

  async function loadRepos(active, searchTerm = "") {
    const seq = beginRead();
    const pluginId = (active || connection)?.pluginId;
    setBusy(value => value + 1);
    setError(null);
    try {
      const result = searchTerm
        ? await call("search_repositories", { query: searchTerm, limit: 10 }, pluginId)
        : await call("list_repositories", { perPage: 100, sort: "updated", direction: "desc" }, pluginId);
      if (seq !== requestSeq.current) return;
      setRepos(reposFrom(result));
      setSearched(Boolean(searchTerm));
      setStatus("ready");
    } catch (readError) {
      if (seq !== requestSeq.current) return;
      setError(errorState(readError));
      setStatus("error");
    } finally {
      setBusy(value => value - 1);
    }
  }

  async function loadTree(target, pluginId) {
    const seq = beginRead();
    setBusy(value => value + 1);
    setError(null);
    setStatus("loading");
    try {
      const listing = await call(
        "list_files",
        {
          owner: target.repo.owner,
          repo: target.repo.name,
          path: target.path,
          branch: target.branch,
          perPage: 300
        },
        pluginId
      );
      if (seq !== requestSeq.current) return;
      setEntries({
        folders: Array.isArray(listing?.folders) ? listing.folders : [],
        files: Array.isArray(listing?.files) ? listing.files : []
      });
      setTruncated(Boolean(listing?.truncated));
      if (target.path === "") await loadReadme(target, seq, pluginId);
      else setReadme(null);
      setStatus("ready");
    } catch (readError) {
      if (seq !== requestSeq.current) return;
      setError(errorState(readError));
      setStatus("error");
    } finally {
      setBusy(value => value - 1);
    }
  }

  /* The backend has no README tool, so the contents endpoint is asked for the
     two spellings that cover almost every repository. When both miss, no README
     is shown — nothing is fetched from a mirror to fill the gap. */
  async function loadReadme(target, seq, pluginId) {
    for (const path of README_CANDIDATES.slice(0, 2)) {
      try {
        const result = await call(
          "read_file",
          { owner: target.repo.owner, repo: target.repo.name, path, branch: target.branch },
          pluginId
        );
        if (seq !== requestSeq.current) return;
        if (result?.content) {
          setReadme({ path, content: result.content, truncated: Boolean(result.truncated) });
          return;
        }
      } catch {
        /* that spelling has no README; ask for the next one */
      }
    }
    if (seq === requestSeq.current) setReadme(null);
  }

  async function loadFile(target, pluginId) {
    const seq = beginRead();
    setBusy(value => value + 1);
    setError(null);
    setStatus("loading");
    try {
      const result = await call(
        "read_file",
        { owner: target.repo.owner, repo: target.repo.name, path: target.path, branch: target.branch },
        pluginId
      );
      if (seq !== requestSeq.current) return;
      setFile(result);
      setStatus("ready");
    } catch (readError) {
      if (seq !== requestSeq.current) return;
      setError(errorState(readError));
      setStatus("error");
    } finally {
      setBusy(value => value - 1);
    }
  }

  async function loadBranches(target) {
    setBusy(value => value + 1);
    setError(null);
    try {
      const result = await call("list_branches", {
        owner: target.repo.owner,
        repo: target.repo.name,
        perPage: 100
      });
      setBranches(Array.isArray(result?.branches) ? result.branches : []);
      if (result?.rateLimit?.remaining === 0) setError(errorState({ status: 403, message: "Rate limit reached." }));
    } catch (readError) {
      setError(errorState(readError));
    } finally {
      setBusy(value => value - 1);
    }
  }

  function enter(target) {
    setHistory(current => pushView(current, target));
    if (target.level === "tree") loadTree(target);
    else if (target.level === "file") loadFile(target);
  }

  function openRepo(entry) {
    if (!entry?.owner || !entry?.name) return;
    const fallback = entry.defaultBranch || "main";
    enter({
      level: "tree",
      repo: { ...entry, defaultBranch: entry.defaultBranch || fallback },
      path: "",
      branch: entry.branch || fallback
    });
  }

  function openEntry(entry) {
    const next = {
      level: entry.type === "dir" ? "tree" : "file",
      repo: view.repo,
      path: view.path ? `${view.path}/${entry.name}` : entry.name,
      branch: view.branch
    };
    enter(next);
  }

  function changeBranch(branch) {
    enter({ ...view, branch });
  }

  // Walking back to a list that was never fetched (an opened-by-name start)
  // owes the user the real list, so it is read here rather than left empty.
  function showRepos() {
    if (repos.length === 0 && connected) loadRepos(connection, searched ? query.trim() : "");
    else setStatus("ready");
  }

  function rewind(delta) {
    const next = delta < 0 ? goBack(history) : goForward(history);
    const target = next.present;
    setHistory(next);
    if (!target) return;
    setError(null);
    if (target.level === "repos") showRepos();
    else if (target.level === "tree") loadTree(target);
    else loadFile(target);
  }

  function jumpTo(target) {
    setError(null);
    if (target.level === "repos") {
      setHistory({ past: [], present: target, future: [] });
      showRepos();
      return;
    }
    enter(target);
  }

  function reloadCurrent() {
    if (!view || view.level === "repos") {
      loadRepos(connection, searched ? query.trim() : "");
      return;
    }
    if (view.level === "tree") loadTree(view);
    else loadFile(view);
  }

  function submitSearch(event) {
    event.preventDefault();
    const direct = ownerRepoFrom(query);
    if (direct) {
      openRepo({ ...direct, fullName: `${direct.owner}/${direct.repo}` });
      return;
    }
    if (connected && query.trim()) loadRepos(connection, query.trim());
  }

  async function reconnect() {
    if (!connection?.pluginId) {
      onManage();
      return;
    }
    // A personal access token is only ever pasted on the Extensions screen, so
    // that is where a broken token is fixed; the sign-in row can be re-started
    // from here because no credential value crosses into this component.
    if (connection.state === "token" || connection.reconnectVia === "token") {
      onManage();
      return;
    }
    if (!connection.oauthConfigured) {
      onManage();
      return;
    }
    setBusy(value => value + 1);
    try {
      const start = await startPluginOAuth(connection.pluginId);
      await openExternalUrl(start?.url || "", { title: "GitHub sign in" });
      await onManage?.();
    } catch (startError) {
      setError(errorState(startError));
    } finally {
      setBusy(value => value - 1);
    }
  }

  async function disconnect() {
    setBusy(value => value + 1);
    try {
      await uninstallPlugin(connection.pluginId);
      const result = await readConnection();
      setConnection(result.connection);
      setRepos([]);
      setHistory(EMPTY_HISTORY);
      setConfirmDisconnect(false);
      setStatus("ready");
    } catch (removeError) {
      setError(errorState(removeError));
    } finally {
      setBusy(value => value - 1);
    }
  }

  // The connection decides which plugin row every call is made against, so it
  // is read when the dialog opens and again after a disconnect.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    returnFocus.current = document.activeElement;
    (async () => {
      setStatus("loading");
      setError(null);
      try {
        const result = await readConnection();
        if (cancelled) return;
        setConnection(result.connection);
        if (!result.card) {
          setError(errorState({ code: "plugin_not_installed" }));
          setStatus("error");
          return;
        }
        const usable = result.connection.state === "token" || result.connection.state === "oauth";
        const start = initialRepo?.owner && initialRepo?.name ? initialRepo : null;
        if (start) {
          // "/github owner/repo" opens straight inside the repository, so the
          // list behind it is loaded only when the user walks back to it.
          const branch = start.branch || start.defaultBranch || "main";
          const target = { level: "tree", repo: { ...start, branch }, path: "", branch };
          setHistory({ past: [{ level: "repos" }], present: target, future: [] });
          loadTree(target, result.connection.pluginId);
        } else if (usable) {
          await loadRepos(result.connection);
        } else {
          setRepos([]);
          setStatus("ready");
        }
      } catch (loadError) {
        if (cancelled) return;
        setError(errorState(loadError));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => {
      if (event.key === "Escape") {
        if (busy > 0) return;
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) || [])].filter(
        node => node.getClientRects().length > 0
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, busy, onClose]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
      return;
    }
    setHistory(EMPTY_HISTORY);
    setQuery("");
    setSearched(false);
    setBranches([]);
    setReadme(null);
    setFile(null);
    setConfirmDisconnect(false);
    returnFocus.current?.focus?.({ preventScroll: true });
  }, [open]);

  const visibleRepos = useMemo(
    () => (searched ? repos : filterRepos(repos, query)),
    [repos, query, searched]
  );

  const crumb = useMemo(() => {
    if (!view) return [{ label: "Repositories" }];
    if (view.level === "repos") return [{ label: "Repositories" }];
    const parts = [{ label: repoLabel(view.repo), view: { level: "repos" } }];
    if (!view.path) return [...parts, { label: view.branch }];
    const segments = view.path.split("/");
    return [
      ...parts,
      ...segments.map((segment, index) => ({
        label: segment,
        view:
          index === segments.length - 1 && view.level === "file"
            ? { ...view }
            : { level: "tree", repo: view.repo, path: segments.slice(0, index + 1).join("/"), branch: view.branch }
      }))
    ];
  }, [view]);

  if (!open) return null;

  return (
    <div
      className="vr-ghb-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget && busy === 0) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="vr-ghb"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vr-ghb-title"
        tabIndex={-1}
      >
        <header className="vr-ghb__head">
          <div className="vr-ghb__title-wrap">
            <span className="vr-ghb__kicker">GitHub</span>
            <h2 id="vr-ghb-title" className="vr-ghb__title">
              {view && view.level !== "repos" ? repoLabel(view.repo) : "Your repositories"}
            </h2>
          </div>
          <div className="vr-ghb__head-side">
            <span className={`vr-ghb__conn vr-ghb__conn--${connection?.state || "none"}`}>
              {connection ? displayName(connection) : "Checking…"}
              {connection?.account ? ` ${connection.account}` : ""}
            </span>
            <button type="button" className="vr-ghb__close" aria-label="Close repository browser" onClick={onClose}>
              <X size={16} weight="bold" />
            </button>
          </div>
        </header>

        <div className="vr-ghb__bar">
          <div className="vr-ghb__nav">
            <button
              type="button"
              className="vr-ghb__navbtn"
              aria-label="Back"
              disabled={history.past.length === 0 || busy > 0}
              onClick={() => rewind(-1)}
            >
              <CaretLeft size={14} weight="bold" />
            </button>
            <button
              type="button"
              className="vr-ghb__navbtn"
              aria-label="Forward"
              disabled={history.future.length === 0 || busy > 0}
              onClick={() => rewind(1)}
            >
              <CaretRight size={14} weight="bold" />
            </button>
          </div>
          <nav className="vr-ghb__crumbs" aria-label="Repository path">
            {crumb.map((part, index) => (
              <span key={`${part.label}-${index}`} className="vr-ghb__crumb">
                {index > 0 ? <span aria-hidden="true">/</span> : null}
                {part.view ? (
                  <button type="button" onClick={() => jumpTo(part.view)}>
                    {part.label}
                  </button>
                ) : (
                  <span aria-current="page">{part.label}</span>
                )}
              </span>
            ))}
          </nav>
          <form className="vr-ghb__search" onSubmit={submitSearch} role="search">
            <label className="vr-ghb__search-label">
              <MagnifyingGlass size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder={connected ? "Search repositories, or type owner/repo" : "Type owner/repo to open a public repository"}
                aria-label="Search GitHub repositories"
                autoComplete="off"
                spellCheck={false}
                onChange={event => {
                  setQuery(event.target.value);
                  setSearched(false);
                }}
              />
            </label>
            <button type="submit" className="vr-ghb__ghost" disabled={busy > 0 || !query.trim()}>
              Search
            </button>
          </form>
          <div className="vr-ghb__tools">
            {view && view.level !== "repos" ? (
              <button
                type="button"
                className="vr-ghb__ghost"
                onClick={() => loadBranches(view)}
                title="Load this repository's branches"
              >
                <GitBranch size={14} aria-hidden="true" />
                {view.branch}
              </button>
            ) : null}
            <button
              type="button"
              className="vr-ghb__ghost"
              aria-label="Reload this view"
              disabled={busy > 0}
              onClick={reloadCurrent}
            >
              <ArrowsClockwise size={14} aria-hidden="true" />
            </button>
            {view?.repo?.url ? (
              <button
                type="button"
                className="vr-ghb__ghost"
                onClick={() => openExternalUrl(view.repo.url, { title: "Open on GitHub" })}
              >
                <ArrowSquareOut size={14} aria-hidden="true" />
                GitHub
              </button>
            ) : null}
          </div>
        </div>

        {branches.length > 0 && view && view.level !== "repos" ? (
          <div className="vr-ghb__branches" role="group" aria-label="Switch branch">
            <ListBullets size={13} aria-hidden="true" />
            {branches.slice(0, 24).map(branch => (
              <button
                key={branch.name}
                type="button"
                className="vr-ghb__branch"
                data-on={branch.name === view.branch ? "" : undefined}
                onClick={() => changeBranch(branch.name)}
              >
                {branch.name}
              </button>
            ))}
          </div>
        ) : null}

        {confirmDisconnect ? (
          <div className="vr-ghb__confirm" role="alertdialog" aria-label="Disconnect GitHub">
            <span>
              Disconnecting removes the saved {connection?.state === "oauth" ? "sign-in" : "access token"} for this
              account. Your chats and settings are untouched.
            </span>
            <button type="button" className="vr-ghb__danger" onClick={disconnect}>
              Confirm disconnect
            </button>
            <button type="button" className="vr-ghb__ghost" onClick={() => setConfirmDisconnect(false)}>
              Cancel
            </button>
          </div>
        ) : null}

        <div className="vr-ghb__body">
          {busy > 0 ? (
            <div className="vr-ghb__loading" role="status">
              <CircleNotch size={16} className="vr-ghb__spin" aria-hidden="true" />
              Asking GitHub…
            </div>
          ) : null}

          {status === "error" && error ? (
            <Notice state={error} onRetry={reloadCurrent} onReconnect={reconnect} onManage={onManage} />
          ) : null}

          {!view || view.level === "repos" ? (
            <div className="vr-ghb__list">
              {!connected && status === "ready" && !error ? (
                <div className="vr-ghb__empty">
                  <p>{connection?.sentence || "GitHub is not connected, so your own repository list cannot be read."}</p>
                  <div className="vr-ghb__actions">
                    {connection?.oauthConfigured ? (
                      <button type="button" className="vr-ghb__primary" onClick={reconnect}>
                        <Plugs size={14} aria-hidden="true" />
                        Sign in with GitHub
                      </button>
                    ) : null}
                    <button type="button" className="vr-ghb__ghost" onClick={onManage}>
                      Add an access token
                    </button>
                  </div>
                </div>
              ) : null}
              {connected && visibleRepos.length === 0 && status === "ready" ? (
                <p className="vr-ghb__none">
                  {query
                    ? `GitHub returned no repository matching "${query}".`
                    : "This account has no repositories to list."}
                </p>
              ) : null}
              {visibleRepos.map(repo => (
                <Row
                  key={repo.fullName}
                  icon={FolderSimple}
                  label={repo.fullName}
                  hint={[
                    repo.private ? "private" : "public",
                    repo.defaultBranch || "",
                    repo.description || ""
                  ].filter(Boolean).join(" · ")}
                  onClick={() => openRepo(repo)}
                />
              ))}
            </div>
          ) : null}

          {view?.level === "tree" && status === "ready" ? (
            <div className="vr-ghb__list">
              {entries.folders.length === 0 && entries.files.length === 0 ? (
                <p className="vr-ghb__none">
                  {view.path
                    ? `"${view.path}" has no files on ${view.branch}.`
                    : `This repository has no files on ${view.branch}.`}
                </p>
              ) : null}
              {sortEntries([
                ...entries.folders.map(entry => ({ ...entry, type: "dir" })),
                ...entries.files.map(entry => ({ ...entry, type: "file" }))
              ]).map(entry => (
                <Row
                  key={`${entry.type}-${entry.path || entry.name}`}
                  icon={entry.type === "dir" ? FolderSimple : FileText}
                  label={entry.name}
                  hint={
                    entry.type === "dir"
                      ? "folder"
                      : `${(Number(entry.size) || 0).toLocaleString()} bytes`
                  }
                  onClick={() => openEntry(entry)}
                />
              ))}
              {truncated ? (
                <p className="vr-ghb__note">GitHub returned the first 300 entries for this folder; the rest are not listed.</p>
              ) : null}
              {view.path === "" && readme ? (
                <article className="vr-ghb__readme">
                  <h3 className="vr-ghb__readme-title">{readme.path}</h3>
                  <div className="vr-ghb__markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                      {readme.content}
                    </ReactMarkdown>
                  </div>
                  {readme.truncated ? <p className="vr-ghb__note">GitHub truncated this file; the rest was not sent.</p> : null}
                </article>
              ) : null}
            </div>
          ) : null}

          {view?.level === "file" && status === "ready" && file ? (
            <div className="vr-ghb__file">
              {file.binary ? (
                <p className="vr-ghb__none">
                  {file.path} is not text, so VupsRouter does not show it.
                  {file.size ? ` ${Number(file.size).toLocaleString()} bytes.` : ""}
                </p>
              ) : (
                <pre className="vr-ghb__code">
                  <code>{file.content ?? ""}</code>
                </pre>
              )}
              {file.truncated ? (
                <p className="vr-ghb__note">GitHub sends at most 40,000 characters per file; this one is longer.</p>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className="vr-ghb__foot">
          {view && view.level !== "repos" ? (
            <button
              type="button"
              className="vr-ghb__primary"
              onClick={() => {
                onScope?.(view.repo, view.branch);
                onClose();
              }}
            >
              Use {repoLabel(view.repo)} in this chat
            </button>
          ) : (
            <button
              type="button"
              className="vr-ghb__ghost"
              disabled={!connected}
              onClick={() => setConfirmDisconnect(true)}
            >
              Disconnect GitHub
            </button>
          )}
          <span className="vr-ghb__foot-note">
            {busy > 0 ? "Reading GitHub…" : "Reads only. Nothing here writes to GitHub."}
          </span>
          <button type="button" className="vr-ghb__ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}
