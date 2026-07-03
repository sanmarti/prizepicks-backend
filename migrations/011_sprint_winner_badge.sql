-- Sprint Winner badge: awarded to the player who finishes #1 globally across all divisions in a monthly sprint
INSERT INTO badges (code, name, description, icon)
VALUES ('SPRINT_WINNER', 'Sprint Winner', 'Finished #1 globally across all divisions in a monthly sprint', '🏆')
ON CONFLICT (code) DO NOTHING;
