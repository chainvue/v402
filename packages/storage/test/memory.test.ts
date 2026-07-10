import { InMemoryStorage } from "../src/index.js";
import { describeStorageContract } from "./storage-contract.js";

describeStorageContract("InMemoryStorage", async () => new InMemoryStorage());
