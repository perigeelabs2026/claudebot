-- The Chief of Staff works at the workshop desk (right), clear of the lit window, so its needs-you bubble reads on the wall as designed.
UPDATE agent_definitions SET station = 'workshop' WHERE id = 'coordinator' AND station = 'table';
