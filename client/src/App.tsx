import { useState } from "react";
import { Editor } from "./Editor";
import { getDocId } from "./docId";

export function App() {
  const [docId] = useState(getDocId);
  return <Editor docId={docId} />;
}
