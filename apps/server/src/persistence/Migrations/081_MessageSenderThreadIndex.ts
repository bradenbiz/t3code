import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX orchestration_v2_projection_messages_sender_thread_idx
    ON orchestration_v2_projection_messages (
      json_extract(payload_json, '$.senderThreadId'),
      thread_id
    )
    WHERE json_extract(payload_json, '$.senderThreadId') IS NOT NULL
  `;
});
