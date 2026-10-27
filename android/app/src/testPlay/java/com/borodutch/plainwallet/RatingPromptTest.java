package com.borodutch.plainwallet;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class RatingPromptTest {
    static Map<String, Object> state(long first, long days, long confirmed) {
        Map<String, Object> s = new HashMap<>();
        s.put("first", first);
        s.put("days", days);
        s.put("confirmed", confirmed);
        return s;
    }

    @Test
    public void rule() {
        assertFalse(RatingPrompt.due(new HashMap<>(), 100, 504)); // a fresh install
        assertTrue(RatingPrompt.due(state(100, 3, 3), 103, 504));
        assertFalse(RatingPrompt.due(state(100, 2, 3), 103, 504)); // used on 2 days only
        assertFalse(RatingPrompt.due(state(101, 3, 3), 103, 504)); // first used 2 days ago
        assertFalse(RatingPrompt.due(state(100, 3, 2), 103, 504)); // 2 confirmed transactions

        Map<String, Object> once = state(100, 3, 3);
        once.put("asked", 1L);
        once.put("askedOn", 103L);
        once.put("askedVersion", 504L);
        assertFalse(RatingPrompt.due(once, 222, 505)); // 119 days later
        assertFalse(RatingPrompt.due(once, 223, 504)); // 120 days later, the same version
        assertTrue(RatingPrompt.due(once, 223, 505));
        once.put("asked", 2L);
        assertFalse(RatingPrompt.due(once, 1000, 900)); // never a third time
    }
}
