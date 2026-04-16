export interface KeywordMatch {
  keyword: string;
  x: number;
  y: number;
  width: number;
  height: number;
  lastSeen: number; // timestamp
}

export class MatchManager {
  private matches: Map<string, KeywordMatch> = new Map();
  private readonly POSITION_TOLERANCE = 10; // pixels
  private readonly EXPIRY_TIME = 5000; // 5 seconds

  private getMatchKey(match: KeywordMatch): string {
    // Round to tolerance grid to group nearby matches
    const gridX = Math.round(match.x / this.POSITION_TOLERANCE) * this.POSITION_TOLERANCE;
    const gridY = Math.round(match.y / this.POSITION_TOLERANCE) * this.POSITION_TOLERANCE;
    return `${match.keyword}:${gridX},${gridY}`;
  }

  private isSimilarPosition(
    match1: KeywordMatch,
    match2: KeywordMatch
  ): boolean {
    return (
      Math.abs(match1.x - match2.x) <= this.POSITION_TOLERANCE &&
      Math.abs(match1.y - match2.y) <= this.POSITION_TOLERANCE &&
      Math.abs(match1.width - match2.width) <= this.POSITION_TOLERANCE &&
      Math.abs(match1.height - match2.height) <= this.POSITION_TOLERANCE
    );
  }

  addMatches(newMatches: Array<{x: number, y: number, width: number, height: number}>, keyword: string = 'LLM') {
    const now = Date.now();

    for (const match of newMatches) {
      const keywordMatch: KeywordMatch = {
        keyword,
        x: match.x,
        y: match.y,
        width: match.width,
        height: match.height,
        lastSeen: now
      };

      const key = this.getMatchKey(keywordMatch);

      // Check if we already have a similar match
      const existing = this.matches.get(key);
      if (existing && this.isSimilarPosition(existing, keywordMatch)) {
        // Update timestamp and use average position for stability
        existing.x = (existing.x + keywordMatch.x) / 2;
        existing.y = (existing.y + keywordMatch.y) / 2;
        existing.width = (existing.width + keywordMatch.width) / 2;
        existing.height = (existing.height + keywordMatch.height) / 2;
        existing.lastSeen = now;
      } else {
        // New match
        this.matches.set(key, keywordMatch);
      }
    }

    // Clean up expired matches
    this.cleanupExpired();
  }

  removeMatchesInRegions(regions: Array<{x: number, y: number, width: number, height: number}>) {
    for (const [key, match] of this.matches.entries()) {
      for (const region of regions) {
        if (this.isOverlapping(match, region)) {
          this.matches.delete(key);
          break;
        }
      }
    }
  }

  private isOverlapping(
    rect1: {x: number, y: number, width: number, height: number},
    rect2: {x: number, y: number, width: number, height: number}
  ): boolean {
    return !(
      rect1.x + rect1.width < rect2.x ||
      rect2.x + rect2.width < rect1.x ||
      rect1.y + rect1.height < rect2.y ||
      rect2.y + rect2.height < rect1.y
    );
  }

  private cleanupExpired() {
    const now = Date.now();
    for (const [key, match] of this.matches.entries()) {
      if (now - match.lastSeen > this.EXPIRY_TIME) {
        this.matches.delete(key);
      }
    }
  }

  getAllMatches(): Array<{x: number, y: number, width: number, height: number, keyword: string}> {
    return Array.from(this.matches.values()).map(m => ({
      x: m.x,
      y: m.y,
      width: m.width,
      height: m.height,
      keyword: m.keyword
    }));
  }

  clear() {
    this.matches.clear();
  }

  getStats() {
    return {
      total: this.matches.size,
      byKeyword: Array.from(this.matches.values()).reduce((acc, m) => {
        acc[m.keyword] = (acc[m.keyword] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
    };
  }
}
