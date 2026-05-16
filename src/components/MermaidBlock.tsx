import { useEffect, useId, useState } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'strict'
});

type Props = {
  content: string;
};

export function MermaidBlock({ content }: Props) {
  const id = useId().replace(/:/g, '');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    mermaid
      .render(`mermaid-${id}`, content)
      .then((result) => {
        if (!active) return;
        setSvg(result.svg);
        setError('');
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      active = false;
    };
  }, [content, id]);

  if (error) {
    return <pre className="code-panel">{error}</pre>;
  }

  return <div className="mermaid-shell" dangerouslySetInnerHTML={{ __html: svg }} />;
}
