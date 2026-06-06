import { render, screen } from '@testing-library/react';
import { InstructionsMarkdown } from './InstructionsMarkdown';

describe('InstructionsMarkdown', () => {
  it('renders headings, lists, inline code, and fenced code blocks', () => {
    render(
      <InstructionsMarkdown
        markdown={`# Lesson one

- Press \`A\`
- Open the log

\`\`\`python
radio.send("ping")
\`\`\``}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Lesson one' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByText('A', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('radio.send("ping")', { selector: 'code' })).toBeInTheDocument();
  });

  it('treats markdown-like text inside fenced code as literal code content', () => {
    render(
      <InstructionsMarkdown
        markdown={`\`\`\`
# not a heading
- not a list
\`\`\``}
      />,
    );

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText(/# not a heading/, { selector: 'code' })).toHaveTextContent(
      '# not a heading - not a list',
    );
  });
});
