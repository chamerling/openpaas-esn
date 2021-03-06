'use strict';

angular.module('linagora.esn.unifiedinbox')

  .constant('MAILBOX_ROLE_ICONS_MAPPING', {
    default: 'mdi mdi-email',
    inbox: 'mdi mdi-email',
    archive: 'mdi mdi-email',
    drafts: 'mdi mdi-file-document',
    outbox: 'mdi mdi-email',
    sent: 'mdi mdi-send',
    trash: 'mdi mdi-delete',
    spam: 'mdi mdi-email',
    templates: 'mdi mdi-email'
  })
  .constant('INBOX_AUTOCOMPLETE_LIMIT', 20)
  .constant('MAILBOX_LEVEL_SEPARATOR', ' / ')
  .constant('JMAP_GET_MESSAGES_LIST', ['id', 'threadId', 'subject', 'from', 'preview', 'date', 'isUnread', 'isFlagged', 'hasAttachment', 'mailboxIds'])
  .constant('JMAP_GET_MESSAGES_VIEW', ['id', 'threadId', 'subject', 'from', 'to', 'cc', 'bcc', 'replyTo', 'preview', 'textBody', 'htmlBody', 'date', 'isUnread', 'isFlagged', 'isDraft', 'hasAttachment', 'attachments', 'mailboxIds'])
  .constant('ELEMENTS_PER_PAGE', 20);
