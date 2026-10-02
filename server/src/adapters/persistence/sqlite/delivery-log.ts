import Database from 'better-sqlite3';
import { DeliveryLog } from '../../../shared-kernel';

export class SqliteDeliveryLog implements DeliveryLog {
  constructor(private readonly db: Database.Database) {}

  async recordOnce(source: string, deliveryId: string, at: Date) {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO deliveries (source, delivery_id, received_at) VALUES (?, ?, ?)')
      .run(source, deliveryId, at.toISOString());
    return r.changes === 1;
  }

  async forget(source: string, deliveryId: string) {
    this.db.prepare('DELETE FROM deliveries WHERE source = ? AND delivery_id = ?').run(source, deliveryId);
  }

  async prune(olderThan: Date) {
    return this.db.prepare('DELETE FROM deliveries WHERE received_at < ?').run(olderThan.toISOString()).changes;
  }
}
