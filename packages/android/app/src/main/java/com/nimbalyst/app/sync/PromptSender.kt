package com.nimbalyst.app.sync

import com.nimbalyst.app.attachments.ImageCompressor
import com.nimbalyst.app.attachments.PendingAttachment
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.QueuedPromptEntity
import java.util.UUID

/**
 * Queues a prompt for the desktop: encrypts the text and attachments,
 * publishes it on the index, and records it locally only once the send
 * succeeded. Never replayed: a prompt resent after reconnect could run twice.
 */
internal class PromptSender(
    private val repository: NimbalystRepository,
    private val indexUpdates: SessionIndexUpdates,
    private val crypto: () -> CryptoManager?,
    private val isIndexConnected: () -> Boolean,
    private val sendIndex: (String) -> Boolean,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** Returns the queued prompt's id on success. */
    suspend fun send(sessionId: String, text: String, attachments: List<PendingAttachment>): Result<String> {
        val promptText = text.trim()
        if (promptText.isBlank() && attachments.isEmpty()) {
            return Result.failure(IllegalArgumentException("Prompt cannot be empty."))
        }
        val crypto = crypto() ?: return Result.failure(IllegalStateException("Sync is not ready."))
        if (!isIndexConnected()) return Result.failure(IllegalStateException("Index room is not connected."))
        val session = repository.getSession(sessionId)
            ?: return Result.failure(IllegalStateException("Session not found."))

        return runCatching {
            val now = clock()
            val promptId = UUID.randomUUID().toString()
            val encryptedPrompt = crypto.encrypt(promptText)
            val queuedPrompt = EncryptedQueuedPrompt(
                id = promptId,
                encryptedPrompt = encryptedPrompt.encrypted,
                iv = encryptedPrompt.iv,
                timestamp = now,
                source = "keyboard"
            ).also { prompt ->
                prompt.encryptedAttachments = attachments.mapNotNull { attachment ->
                    val compressed = ImageCompressor.compress(attachment.bitmap) ?: return@mapNotNull null
                    val encrypted = crypto.encryptData(compressed.data)
                    WireEncryptedAttachment(
                        id = attachment.id,
                        filename = attachment.filename,
                        mimeType = "image/jpeg",
                        encryptedData = encrypted.encrypted,
                        iv = encrypted.iv,
                        size = compressed.data.size,
                        width = compressed.width,
                        height = compressed.height
                    )
                }.takeIf { it.isNotEmpty() }
            }

            val update = indexUpdates.prompt(session, queuedPrompt, crypto)
            check(sendIndex(update)) { "Failed to send prompt update." }

            repository.upsertQueuedPrompt(
                QueuedPromptEntity(
                    id = promptId,
                    sessionId = sessionId,
                    promptTextEncrypted = encryptedPrompt.encrypted,
                    iv = encryptedPrompt.iv,
                    createdAt = now,
                    sentAt = now,
                    promptTextDecrypted = promptText,
                    source = null
                )
            )
            repository.upsertSession(session.copy(hasQueuedPrompts = true, updatedAt = now, lastMessageAt = now))
            promptId
        }
    }
}
