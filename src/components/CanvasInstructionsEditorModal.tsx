import { useEffect, useRef, useState } from 'react';

interface CanvasInstructionsEditorModalProps {
  initialInstructions?: string;
  onClose: () => void;
  onSave: (nextInstructions: string) => void;
}

export function CanvasInstructionsEditorModal({
  initialInstructions,
  onClose,
  onSave,
}: CanvasInstructionsEditorModalProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draftInstructions, setDraftInstructions] = useState(initialInstructions ?? '');

  useEffect(() => {
    setDraftInstructions(initialInstructions ?? '');
  }, [initialInstructions]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div
      className="instructions-editor-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Canvas instructions editor"
      onClick={onClose}
    >
      <div className="instructions-editor-modal__card" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="instructions-editor-modal__close"
          aria-label="Close instructions editor"
          onClick={onClose}
        >
          ×
        </button>
        <p className="metric-label">Canvas instructions</p>
        <div className="instructions-editor-modal__header">
          <strong>Instructions shown when this canvas is loaded</strong>
          <span>Supports headings, lists, inline code, and fenced code blocks.</span>
        </div>
        <textarea
          ref={textareaRef}
          className="instructions-editor-modal__textarea"
          aria-label="Canvas instructions markdown"
          value={draftInstructions}
          onChange={(event) => setDraftInstructions(event.target.value)}
          placeholder="# Lesson instructions&#10;&#10;- Load code onto Node 1&#10;- Press button A to begin&#10;&#10;```python&#10;radio.send('hello')&#10;```"
          spellCheck={false}
        />
        <p className="hint">Leave this blank to keep the default quick start instructions.</p>
        <div className="instructions-editor-modal__actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => onSave(draftInstructions)}>
            Save instructions
          </button>
        </div>
      </div>
    </div>
  );
}
