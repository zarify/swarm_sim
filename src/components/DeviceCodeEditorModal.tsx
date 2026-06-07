import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { DeviceEditableProgram } from '../domain/project';

interface DeviceCodeEditorModalProps {
  deviceName: string;
  editableProgram: DeviceEditableProgram;
  onClose: () => void;
  onSave: (nextProgram: DeviceEditableProgram) => void;
}

export function DeviceCodeEditorModal({
  deviceName,
  editableProgram,
  onClose,
  onSave,
}: DeviceCodeEditorModalProps) {
  const editableFileName = getEditableFileName(editableProgram.runtimeSource);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const [draftSource, setDraftSource] = useState(() =>
    getEditableSource(editableProgram, editableFileName),
  );

  useEffect(() => {
    setDraftSource(getEditableSource(editableProgram, editableFileName));
  }, [editableProgram, editableFileName]);

  const highlightedSource = useMemo(
    () => highlightSource(draftSource, editableProgram.runtimeSource),
    [draftSource, editableProgram.runtimeSource],
  );

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    syncHighlightedScroll(highlightRef.current, textareaRef.current);
  }, [highlightedSource]);

  return (
    <div
      className="code-editor-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Code editor for ${deviceName}`}
      onClick={onClose}
    >
      <div className="code-editor-modal__card" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="code-editor-modal__close"
          aria-label="Close code editor"
          onClick={onClose}
        >
          ×
        </button>
        <p className="metric-label">Code editor</p>
        <div className="code-editor-modal__header">
          <strong>{deviceName}</strong>
          <span>{editableProgram.runtimeSource === 'micropython' ? 'MicroPython main.py' : 'MakeCode main.ts'}</span>
        </div>
        <div className="code-editor-modal__editor">
          <div className="code-editor-modal__editor-bar">
            <span className="code-editor-modal__file-pill">{editableFileName}</span>
            <span className="code-editor-modal__editor-hint">Tab indents. Shift+Tab outdents. Enter keeps indentation.</span>
          </div>
          <div className="code-editor-modal__surface">
            <pre
              ref={highlightRef}
              className="code-editor-modal__highlight"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: highlightedSource }}
            />
            <textarea
              ref={textareaRef}
              id="device-code-editor-source"
              className="code-editor-modal__textarea"
              aria-label={`Editing ${editableFileName} for ${deviceName}`}
              value={draftSource}
              onChange={(event) => setDraftSource(event.target.value)}
              onScroll={(event) => syncHighlightedScroll(highlightRef.current, event.currentTarget)}
              onKeyDown={(event) => handleEditorKeyDown(event, setDraftSource)}
              spellCheck={false}
              wrap="off"
            />
          </div>
        </div>
        <div className="code-editor-modal__actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onSave(commitProgramDraft(editableProgram, editableFileName, draftSource));
            }}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

function commitProgramDraft(
  editableProgram: DeviceEditableProgram,
  editableFileName: string,
  draftSource: string,
): DeviceEditableProgram {
  switch (editableProgram.runtimeSource) {
    case 'micropython':
      return {
        ...editableProgram,
        files: {
          ...editableProgram.files,
          [editableFileName]: draftSource,
        },
      };
    case 'makecode-pxt':
      return {
        ...editableProgram,
        sourceFiles: {
          ...editableProgram.sourceFiles,
          [editableFileName]: draftSource,
        },
      };
  }
}

function getEditableSource(editableProgram: DeviceEditableProgram, editableFileName: string): string {
  return editableProgram.runtimeSource === 'micropython'
    ? editableProgram.files[editableFileName] ?? ''
    : editableProgram.sourceFiles[editableFileName] ?? '';
}

function getEditableFileName(runtimeSource: DeviceEditableProgram['runtimeSource']): string {
  return runtimeSource === 'micropython' ? 'main.py' : 'main.ts';
}

function syncHighlightedScroll(highlight: HTMLPreElement | null, textarea: HTMLTextAreaElement): void {
  if (!highlight) {
    return;
  }
  highlight.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
}

function handleEditorKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  setDraftSource: (nextSource: string) => void,
): void {
  const textarea = event.currentTarget;
  const { selectionStart, selectionEnd, value } = textarea;

  if (event.key === 'Tab') {
    event.preventDefault();
    if (event.shiftKey) {
      const { nextValue, nextSelectionStart, nextSelectionEnd } = outdentSelection(
        value,
        selectionStart,
        selectionEnd,
      );
      applyTextareaEdit(textarea, nextValue, nextSelectionStart, nextSelectionEnd, setDraftSource);
      return;
    }

    if (selectionStart === selectionEnd) {
      const nextValue = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
      applyTextareaEdit(textarea, nextValue, selectionStart + 2, selectionStart + 2, setDraftSource);
      return;
    }

    const { nextValue, nextSelectionStart, nextSelectionEnd } = indentSelection(
      value,
      selectionStart,
      selectionEnd,
    );
    applyTextareaEdit(textarea, nextValue, nextSelectionStart, nextSelectionEnd, setDraftSource);
    return;
  }

  if (event.key === 'Enter') {
    const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
    const currentIndent = value.slice(lineStart, selectionStart).match(/^[ \t]*/)?.[0] ?? '';
    if (currentIndent.length === 0) {
      return;
    }
    event.preventDefault();
    const nextValue = `${value.slice(0, selectionStart)}\n${currentIndent}${value.slice(selectionEnd)}`;
    const nextCursor = selectionStart + 1 + currentIndent.length;
    applyTextareaEdit(textarea, nextValue, nextCursor, nextCursor, setDraftSource);
  }
}

function indentSelection(value: string, selectionStart: number, selectionEnd: number) {
  const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
  const selectionText = value.slice(lineStart, selectionEnd);
  const indented = selectionText.replace(/^/gm, '  ');
  return {
    nextValue: `${value.slice(0, lineStart)}${indented}${value.slice(selectionEnd)}`,
    nextSelectionStart: selectionStart + 2,
    nextSelectionEnd: selectionEnd + (indented.match(/^  /gm)?.length ?? 0) * 2,
  };
}

function outdentSelection(value: string, selectionStart: number, selectionEnd: number) {
  const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
  const selectionText = value.slice(lineStart, selectionEnd);
  let removedFromStart = 0;
  let removedTotal = 0;
  const outdented = selectionText.replace(/^ {1,2}|^\t/gm, (match, offset) => {
    removedTotal += match.length;
    if (offset === 0) {
      removedFromStart = match.length;
    }
    return '';
  });
  return {
    nextValue: `${value.slice(0, lineStart)}${outdented}${value.slice(selectionEnd)}`,
    nextSelectionStart: Math.max(lineStart, selectionStart - removedFromStart),
    nextSelectionEnd: Math.max(lineStart, selectionEnd - removedTotal),
  };
}

function applyTextareaEdit(
  textarea: HTMLTextAreaElement,
  nextValue: string,
  nextSelectionStart: number,
  nextSelectionEnd: number,
  setDraftSource: (nextSource: string) => void,
): void {
  setDraftSource(nextValue);
  requestAnimationFrame(() => {
    textarea.selectionStart = nextSelectionStart;
    textarea.selectionEnd = nextSelectionEnd;
  });
}

function highlightSource(
  source: string,
  runtimeSource: DeviceEditableProgram['runtimeSource'],
): string {
  const escaped = escapeHtml(source);
  const pattern =
    runtimeSource === 'micropython'
      ? /("""[\s\S]*?"""|'''[\s\S]*?'''|#.*$|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\b(?:and|as|break|class|continue|def|elif|else|except|False|finally|for|from|if|import|in|is|lambda|None|not|or|pass|return|True|try|while|with|yield)\b|\b\d+(?:\.\d+)?\b)/gm
      : /(\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|import|interface|let|new|null|return|switch|true|try|type|undefined|var|while)\b|\b\d+(?:\.\d+)?\b)/gm;

  return (
    escaped.replace(pattern, (token) => {
      if (
        token.startsWith('#') ||
        token.startsWith('//') ||
        token.startsWith('/*')
      ) {
        return `<span class="code-editor-token code-editor-token--comment">${token}</span>`;
      }
      if (
        token.startsWith('"') ||
        token.startsWith("'") ||
        token.startsWith('`')
      ) {
        return `<span class="code-editor-token code-editor-token--string">${token}</span>`;
      }
      if (/^\d/.test(token)) {
        return `<span class="code-editor-token code-editor-token--number">${token}</span>`;
      }
      return `<span class="code-editor-token code-editor-token--keyword">${token}</span>`;
    }) || '&nbsp;'
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
