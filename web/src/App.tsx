import { useEffect, useState } from 'react';

interface Health {
  ok: boolean;
  version: string;
  db: { patients: number; patientDays: number; labs: number };
  dbFile: string;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem' }}>
      <h1>Rekap Visite v2</h1>
      {error && <p style={{ color: 'crimson' }}>API unreachable: {error}</p>}
      {health && (
        <pre style={{ background: '#f4f4f4', padding: '1rem', borderRadius: 8 }}>
          {JSON.stringify(health, null, 2)}
        </pre>
      )}
      <p>
        P1 smoke test — UI buildout starts at P3.
      </p>
    </main>
  );
}
