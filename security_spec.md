# Security Specification for Hiya AI

## Data Invariants
1. A ChatTurn cannot exist without a valid User ID.
2. Users can only read and write their own data.
3. Timestamps must be server-generated or strictly validated.
4. User IDs in the path must match the authenticated user's UID.

## The "Dirty Dozen" Payloads

1. **Identity Spoofing**: Attempt to create a profile with a different UID.
   ```json
   { "displayName": "Attacker", "userId": "victim_uid" }
   ```
2. **Preference Hijacking**: User A tries to read User B's preferences.
   ```json
   // GET /users/user_B_uid
   ```
3. **Ghost Turns**: Creating a chat turn for another user.
   ```json
   // CREATE /users/user_B_uid/history/turn_1
   ```
4. **Shadow Admin**: Attempt to set a `role: "admin"` if it existed.
5. **PII Leak**: Attempt to list all users.
   ```json
   // FETCH /users
   ```
6. **Future Dating**: Setting a timestamp in the future.
7. **Size Bomb**: Sending a 1MB string as a turn.
8. **Invalid ID**: Using `../` or special characters in the turn ID.
9. **Role Escalation**: Attempting to change `role` to something else if applicable.
10. **Orphaned History**: Creating history without a user profile existing (if enforced).
11. **Malicious Fields**: Adding arbitrary fields to the profile.
12. **Recursive Listing**: Listing all history subcollections across all users.

## The Test Runner
(A separate `firestore.rules.test.ts` will be created to verify these).
