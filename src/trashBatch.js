import { authorize } from './auth.js';
import { google } from 'googleapis';

const auth = await authorize();
const gmail = google.gmail({ version: 'v1', auth });

const sendersToTrash = [
  // Batch 3: emails 3000-5000 (remaining after partial run)
  // Already processed: grant@mail.beehiiv.com, value@acquisition.com
  'noreply@e.bloomingdales.com',
  'noreply@github.com',
  'newsletter@mail.beehiiv.com',
  'theaiexchange@mail.beehiiv.com',
  'noreply@substack.com',
  'noreply@discordapp.com',
  'adam.singer@mail.beehiiv.com',
  'mattsays@mail.beehiiv.com',
  'noreply@mail.superhuman.com',
  'bensbites@mail.beehiiv.com',
  'morning@mail.morningbrew.com',
  'noreply@e.wyndhamrewards.com',
  'jobs-noreply@linkedin.com',
  'hello@mail.audiocoffee.co',
  'invitations@linkedin.com',
  'support@brandmark.io',
  'youcubed.stanford@stanford.edu',
  'hello@tldv.io',
  'hello@brevo.com',
  'dan@tldrnewsletter.com',
  'hello@therundown.ai'
];

// Get existing filters
const existingResponse = await gmail.users.settings.filters.list({ userId: 'me' });
const existingFilters = existingResponse.data.filter || [];
const existingFroms = new Set(existingFilters.map(f => f.criteria?.from?.toLowerCase()).filter(Boolean));

let filtersCreated = 0;
let totalTrashed = 0;

for (const sender of sendersToTrash) {
  // Create filter if doesn't exist
  if (!existingFroms.has(sender.toLowerCase())) {
    try {
      await gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria: { from: sender },
          action: { addLabelIds: ['TRASH'] }
        }
      });
      console.log('Created filter:', sender);
      filtersCreated++;
    } catch (err) {
      // Filter might exist
    }
  }

  // Trash existing emails
  try {
    let pageToken = null;
    let messageIds = [];

    do {
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: `from:${sender}`,
        maxResults: 100,
        pageToken
      });

      if (response.data.messages) {
        messageIds = messageIds.concat(response.data.messages.map(m => m.id));
      }
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    if (messageIds.length > 0) {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: messageIds,
          addLabelIds: ['TRASH'],
          removeLabelIds: ['INBOX', 'UNREAD']
        }
      });
      console.log(`Trashed ${messageIds.length} from ${sender}`);
      totalTrashed += messageIds.length;
    }
  } catch (err) {
    console.error('Error:', sender, err.message);
  }

  await new Promise(r => setTimeout(r, 100));
}

console.log('');
console.log('Filters created:', filtersCreated);
console.log('Total emails trashed:', totalTrashed);
