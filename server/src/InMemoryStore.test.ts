import { describeDocumentStoreContract } from "./documentStoreContract";
import { InMemoryStore } from "./InMemoryStore";

describeDocumentStoreContract("InMemoryStore", async () => ({
  fresh: async () => new InMemoryStore(),
  close: async () => {},
}));
