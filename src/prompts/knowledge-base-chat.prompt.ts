import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { RetrievedChunk } from "../integrations/aws/services/bedrock-knowledge-base.service";

/**
 * Builds the RAG prompt for `sat-cli onboard --chat`: instructs the LLM to answer strictly
 * from the retrieved Bedrock Knowledge Base chunks, citing sources by index.
 */
export function getKnowledgeBaseChatMessages(params: { question: string; chunks: RetrievedChunk[] }): {
    system: SystemMessage;
    user: HumanMessage;
} {
    const system = new SystemMessage(
        `You are a helpful assistant answering questions using ONLY the context provided below, which was retrieved from a knowledge base.

Rules:
- Answer using only the given context. If the context doesn't contain enough information to answer, say so plainly instead of guessing.
- Be concise and direct.
- When you use a piece of context, cite it by its number in brackets, e.g. "[1]".`,
    );

    const context = params.chunks.length
        ? params.chunks
              .map((chunk, index) => {
                  const source = chunk.location ? ` (source: ${chunk.location})` : "";
                  return `[${index + 1}]${source}\n${chunk.content.trim()}`;
              })
              .join("\n\n---\n\n")
        : "(No relevant context was found in the knowledge base for this question.)";

    const user = new HumanMessage(`Context:\n${context}\n\nQuestion: ${params.question}`);

    return { system, user };
}
