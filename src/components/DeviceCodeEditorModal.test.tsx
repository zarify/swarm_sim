import { fireEvent, render, screen } from '@testing-library/react';
import { DeviceCodeEditorModal } from './DeviceCodeEditorModal';

describe('DeviceCodeEditorModal', () => {
  it('keeps the syntax-highlight layer aligned with textarea scroll offsets', () => {
    const onClose = () => {};
    const onSave = () => {};

    render(
      <DeviceCodeEditorModal
        deviceName="Node 1"
        editableProgram={{
          runtimeSource: 'micropython',
          baseArtifactId: 'artifact-1',
          revision: 1,
          updatedAt: '2026-06-07T00:00:00.000Z',
          files: {
            'main.py': Array.from({ length: 80 }, (_, index) => `line_${index + 1}`).join('\n'),
          },
        }}
        onClose={onClose}
        onSave={onSave}
      />,
    );

    const textarea = screen.getByLabelText('Editing main.py for Node 1') as HTMLTextAreaElement;
    const highlight = document.querySelector('.code-editor-modal__highlight') as HTMLPreElement;

    Object.defineProperty(textarea, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 420,
    });
    Object.defineProperty(textarea, 'scrollLeft', {
      configurable: true,
      writable: true,
      value: 36,
    });

    fireEvent.scroll(textarea);

    expect(highlight.style.transform).toBe('translate(-36px, -420px)');
  });
});
