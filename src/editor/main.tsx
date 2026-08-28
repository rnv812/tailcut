import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { loadSnapshot } from './source/snapshot'
import { Shell, type EditorState } from './shell'

/**
 * The editor tab.
 *
 * Everything it works on comes out of one file in OPFS named by the address. Nothing is kept
 * between openings and nothing is written back: the snapshot is read-only from the moment the
 * bridge closed it, and F5 rebuilds the same screen from the same bytes.
 */
function Editor() {
  const [state, setState] = useState<EditorState>({ status: 'opening' })

  useEffect(() => {
    void loadSnapshot(window.location.search).then((loaded) =>
      setState(
        loaded.ok
          ? { status: 'ready', reader: loaded.reader, material: loaded.material }
          : { status: 'failed', reason: loaded.reason },
      ),
    )
  }, [])

  return <Shell state={state} />
}

render(<Editor />, document.body)
