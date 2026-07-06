/**
 * forum.js — Enhanced forum: likes, comments, nested replies
 * Shared across farmer.html, consumer.html, organisation.html
 * Call initForum(userData) once after userData is available.
 */

/* ─── Inject CSS once ─────────────────────────────────────────── */
(function injectForumStyles() {
  if (document.getElementById('forum-styles')) return;
  const s = document.createElement('style');
  s.id = 'forum-styles';
  s.textContent = `
    .forum-post { border-bottom: 1px solid #e5e7eb; padding: 20px 0; transition: background .2s; }
    .forum-post:last-child { border-bottom: none; }
    .forum-post:hover { background: #fafafa; border-radius: 12px; }
    .forum-action-bar { display:flex; align-items:center; gap:2px; margin-top:12px; }
    .fa-btn {
      display:inline-flex; align-items:center; gap:5px;
      background:none; border:none; cursor:pointer;
      padding:7px 12px; border-radius:9999px;
      color:#536471; font-size:.9rem; font-weight:500;
      transition: background .18s, color .18s;
    }
    .fa-btn:hover { background:rgba(29,155,240,.1); color:#1d9bf0; }
    .fa-btn.like-btn.liked { color:#f91880; }
    .fa-btn.like-btn.liked:hover { background:rgba(249,24,128,.1); }
    .fa-btn.like-btn.liked svg { fill:#f91880; stroke:#f91880; }
    .fa-btn.delete-btn { color:#f4212e; margin-left:auto; }
    .fa-btn.delete-btn:hover { background:rgba(244,33,46,.1); }
    @keyframes fheart { 0%,100%{transform:scale(1)} 50%{transform:scale(1.35)} }
    .fa-btn.like-btn.liked svg { animation: fheart .25s ease; }
    .forum-comments-section { display:none; margin-top:14px; padding-top:14px; border-top:1px solid #e5e7eb; }
    .comment-item { display:flex; gap:10px; margin-bottom:14px; }
    .comment-body { flex:1; min-width:0; }
    .comment-bubble {
      background:#f3f4f6; border-radius:14px; padding:9px 13px;
      font-size:.9rem; line-height:1.5; color:#111827;
    }
    .comment-meta { font-size:.78rem; color:#536471; margin-top:4px; display:flex; align-items:center; gap:8px; }
    .reply-toggle { background:none;border:none;cursor:pointer;font-size:.78rem;color:#1d9bf0;font-weight:600;padding:0; }
    .reply-form { display:none; margin-top:8px; display:none; align-items:center; gap:8px; }
    .reply-form input {
      flex:1; padding:7px 12px; border:1.5px solid #e5e7eb;
      border-radius:9999px; font-size:.875rem; background:#f9fafb;
      outline:none; transition:border-color .2s;
    }
    .reply-form input:focus { border-color:#1d9bf0; background:#fff; }
    .reply-form .send-btn {
      padding:7px 16px; background:#1d9bf0; color:#fff;
      border:none; border-radius:9999px; cursor:pointer;
      font-size:.875rem; font-weight:700; white-space:nowrap;
    }
    .reply-form .cancel-btn {
      padding:7px 14px; background:#f3f4f6; color:#536471;
      border:none; border-radius:9999px; cursor:pointer; font-size:.875rem;
    }
    .replies-nest { margin-left:42px; margin-top:10px; }
    .comment-input-row { display:flex; gap:8px; align-items:center; margin-top:10px; }
    .comment-input-row input {
      flex:1; padding:9px 14px; border:1.5px solid #e5e7eb;
      border-radius:9999px; font-size:.9rem; background:#f9fafb;
      outline:none; transition:border-color .2s;
    }
    .comment-input-row input:focus { border-color:#1d9bf0; background:#fff; }
    .comment-input-row .send-btn {
      padding:9px 18px; background:#1d9bf0; color:#fff;
      border:none; border-radius:9999px; cursor:pointer;
      font-size:.9rem; font-weight:700;
    }
    .f-avatar {
      border-radius:50%; background:#e8f5e9; color:#1B5E20;
      display:flex; align-items:center; justify-content:center;
      font-weight:700; flex-shrink:0;
    }
    @keyframes fslide { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }
    .comment-item { animation: fslide .2s ease; }
  `;
  document.head.appendChild(s);
})();

/* ─── Helpers ─────────────────────────────────────────────────── */
function _fEsc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _fTime(ts) {
  if (!ts) return '';
  const d = Date.now() - Number(ts);
  const m = Math.floor(d / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.floor(m/60) + 'h ago';
  if (m < 43200) return Math.floor(m/1440) + 'd ago';
  return Math.floor(m/43200) + 'mo ago';
}
function _fInitial(name) { return name ? name.charAt(0).toUpperCase() : '?'; }
function _fAvatar(name, photo, size) {
  size = size || 40;
  if (photo) return '<img src="' + _fEsc(photo) + '" alt="" style="width:'+size+'px;height:'+size+'px;border-radius:50%;object-fit:cover;flex-shrink:0">';
  return '<div class="f-avatar" style="width:'+size+'px;height:'+size+'px;min-width:'+size+'px;font-size:'+Math.floor(size*.38)+'px">'+_fInitial(name)+'</div>';
}
function _fBadge(v) {
  if (!v) return '';
  return '<span title="Verified" style="display:inline-flex;align-items:center;margin-left:3px"><img src="verification badge 32x32.png" alt="✓" style="width:16px;height:16px;border-radius:50%;vertical-align:middle"></span>';
}

/* ─── Module state (set by initForum) ────────────────────────── */
let _fUser   = {};   // { uid, displayName, photoURL }
let _fApi    = null; // the page's api() function

/* ─── Public entry point ──────────────────────────────────────── */
function initForum(userData, apiFn) {
  _fUser = userData || {};
  _fApi  = apiFn || (typeof api !== 'undefined' ? api : null);
}
window.initForum = initForum;

/* ─── Load & render posts ─────────────────────────────────────── */
async function loadForumPosts() {
  const container = document.getElementById('forumPostContainer');
  if (!container) return;
  try {
    const list = await _fApi('/api/forum/posts');
    const countEl = document.getElementById('forumPostCount');
    if (countEl) countEl.textContent = list.length;
    if (!list.length) {
      container.innerHTML = '<div class="entity-empty">No posts yet. Be the first to share something!</div>';
      return;
    }
    container.innerHTML = list.map(_fRenderPost).join('');
  } catch(e) {
    console.error('loadForumPosts:', e);
    container.innerHTML = '<div class="entity-empty">Failed to load posts.</div>';
  }
}
window.loadForumPosts = loadForumPosts;

function _fRenderPost(p) {
  const liked  = p.userLiked || p.user_liked;
  const likes  = p.likeCount  || p.like_count  || 0;
  const cmts   = p.commentCount || p.comment_count || 0;
  const uid    = p.uid || p.user_id;
  const name   = p.displayName || p.display_name || 'Unknown';
  const photo  = p.photoURL    || p.photo_url    || '';
  const verif  = p.isVerified  || p.is_verified  || false;
  const time   = p.createdAt   || p.created_at;
  const banner = (p.bannerImage || p.banner_image)
    ? '<div style="margin:12px 0 0;border-radius:12px;overflow:hidden"><img src="'+_fEsc(p.bannerImage||p.banner_image)+'" style="width:100%;height:auto;display:block;max-height:320px;object-fit:cover" onerror="this.style.display=\'none\'"></div>' : '';

  return `
<div class="forum-post" data-post-id="${p.id}">
  <div style="display:flex;gap:10px;align-items:flex-start">
    ${_fAvatar(name, photo, 44)}
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
        <span style="font-weight:700;font-size:.95rem;color:#0f1419">${_fEsc(name)}</span>
        ${_fBadge(verif)}
        <span style="color:#536471;font-size:.85rem">· ${_fTime(time)}</span>
      </div>
      <div style="font-weight:700;font-size:1.05rem;margin:4px 0 2px;color:#111">${_fEsc(p.title||'')}</div>
      ${p.content ? '<div style="font-size:.95rem;color:#374151;line-height:1.55">'+_fEsc(p.content)+'</div>' : ''}
      ${banner}
      <div class="forum-action-bar">
        <button class="fa-btn" onclick="fToggleComments('${p.id}')">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="f-cmt-count">${cmts}</span>
        </button>
        <button class="fa-btn like-btn${liked?' liked':''}" data-tt="post" data-tid="${p.id}" onclick="fToggleLike('post','${p.id}',this)">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="${liked?'#f91880':'none'}" stroke="${liked?'#f91880':'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          <span class="f-like-count">${likes}</span>
        </button>
        <button class="fa-btn" onclick="fSharePost('${p.id}')">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
        </button>
        ${uid === _fUser.uid
          ? '<button class="fa-btn delete-btn" onclick="fDeletePost(\''+p.id+'\')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>' : ''}
      </div>
    </div>
  </div>
  <div class="forum-comments-section" id="fcmts-${p.id}">
    <div class="f-cmt-list" id="fcmtlist-${p.id}"></div>
    <div class="comment-input-row">
      ${_fAvatar(_fUser.displayName||_fUser.display_name, _fUser.photoURL||_fUser.photo_url, 32)}
      <input id="fcmt-input-${p.id}" type="text" placeholder="Write a comment…" onkeypress="if(event.key==='Enter')fSubmitComment('${p.id}')">
      <button class="send-btn" onclick="fSubmitComment('${p.id}')">Post</button>
    </div>
  </div>
</div>`;
}

/* ─── Toggle comments section ─────────────────────────────────── */
async function fToggleComments(postId) {
  const sec = document.getElementById('fcmts-' + postId);
  if (!sec) return;
  const open = sec.style.display === 'block';
  sec.style.display = open ? 'none' : 'block';
  if (!open) {
    const list = document.getElementById('fcmtlist-' + postId);
    if (list && !list.dataset.loaded) await fLoadComments(postId);
  }
}
window.fToggleComments = fToggleComments;

/* ─── Load comments ───────────────────────────────────────────── */
async function fLoadComments(postId) {
  const list = document.getElementById('fcmtlist-' + postId);
  if (!list) return;
  list.innerHTML = '<div style="padding:10px;color:#9ca3af;font-size:.85rem">Loading…</div>';
  try {
    const data = await _fApi('/api/forum/posts/' + postId + '/comments');
    // API returns a plain array
    const comments = Array.isArray(data) ? data : (data.comments || []);
    list.dataset.loaded = '1';
    if (!comments.length) {
      list.innerHTML = '<div style="padding:10px;color:#9ca3af;font-size:.85rem;text-align:center">No comments yet.</div>';
      return;
    }
    list.innerHTML = comments.map(c => _fRenderComment(c, postId, false)).join('');
  } catch(e) {
    console.error('fLoadComments:', e);
    list.innerHTML = '<div style="padding:10px;color:#ef4444;font-size:.85rem">Failed to load comments.</div>';
  }
}
window.fLoadComments = fLoadComments;

function _fRenderComment(c, postId, isReply) {
  const name  = c.display_name || c.displayName || 'Unknown';
  const photo = c.photo_url    || c.photoURL    || '';
  const verif = c.is_verified  || c.isVerified  || false;
  const liked = c.user_liked   || c.userLiked   || false;
  const likes = parseInt(c.like_count || c.likeCount || 0);
  const avatarSize = isReply ? 30 : 36;

  const repliesHtml = (!isReply && c.replies && c.replies.length)
    ? '<div class="replies-nest">' + c.replies.map(r => _fRenderComment(r, postId, true)).join('') + '</div>'
    : '';

  return `
<div class="comment-item" data-cmt-id="${c.id}" data-post-id="${postId}">
  ${_fAvatar(name, photo, avatarSize)}
  <div class="comment-body">
    <div class="comment-bubble">
      <div style="font-weight:700;font-size:.85rem;display:flex;align-items:center;gap:4px;margin-bottom:2px">
        ${_fEsc(name)}${_fBadge(verif)}
      </div>
      <div>${_fEsc(c.content)}</div>
    </div>
    <div class="comment-meta">
      <span>${_fTime(c.created_at || c.createdAt)}</span>
      <button class="fa-btn like-btn${liked?' liked':''}" style="padding:3px 7px;font-size:.78rem"
        onclick="fToggleLike('comment','${c.id}',this)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="${liked?'#f91880':'none'}" stroke="${liked?'#f91880':'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        <span class="f-like-count">${likes}</span>
      </button>
      ${!isReply ? '<button class="reply-toggle" onclick="fShowReplyForm(\''+c.id+'\')">Reply</button>' : ''}
      ${c.uid === _fUser.uid ? '<button class="reply-toggle" style="color:#f4212e" onclick="fDeleteComment(\''+c.id+'\',\''+postId+'\')">Delete</button>' : ''}
    </div>
    ${!isReply ? `
    <div class="reply-form" id="freply-${c.id}">
      ${_fAvatar(_fUser.displayName||_fUser.display_name, _fUser.photoURL||_fUser.photo_url, 28)}
      <input id="freply-input-${c.id}" type="text" placeholder="Write a reply…" onkeypress="if(event.key==='Enter')fSubmitReply('${c.id}','${postId}')">
      <button class="send-btn" onclick="fSubmitReply('${c.id}','${postId}')">Reply</button>
      <button class="cancel-btn" onclick="fHideReplyForm('${c.id}')">Cancel</button>
    </div>` : ''}
  </div>
</div>
${repliesHtml}`;
}

/* ─── Like toggle ─────────────────────────────────────────────── */
async function fToggleLike(type, id, btn) {
  if (!btn) return;
  const isLiked = btn.classList.contains('liked');
  const method  = isLiked ? 'DELETE' : 'POST';
  const ep = type === 'post'
    ? '/api/forum/posts/'    + id + '/like'
    : '/api/forum/comments/' + id + '/like';
  btn.disabled = true;
  try {
    const res = await _fApi(ep, { method });
    const nowLiked = !!res.liked;
    btn.classList.toggle('liked', nowLiked);
    const svg = btn.querySelector('svg');
    if (svg) {
      svg.setAttribute('fill',   nowLiked ? '#f91880' : 'none');
      svg.setAttribute('stroke', nowLiked ? '#f91880' : 'currentColor');
    }
    const cnt = btn.querySelector('.f-like-count');
    if (cnt) cnt.textContent = res.likeCount != null ? res.likeCount : (nowLiked ? parseInt(cnt.textContent)+1 : Math.max(0,parseInt(cnt.textContent)-1));
  } catch(e) {
    console.error('fToggleLike:', e);
    if (typeof showToast === 'function') showToast('Failed to update like', 'error');
  } finally {
    btn.disabled = false;
  }
}
window.fToggleLike = fToggleLike;

/* ─── Share post ──────────────────────────────────────────────── */
function fSharePost(postId) {
  const url = location.origin + location.pathname + '#post-' + postId;
  if (navigator.share) {
    navigator.share({ title: 'AgriConnect post', url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).then(
      () => { if (typeof showToast === 'function') showToast('Link copied!', 'success'); },
      () => {}
    );
  }
}
window.fSharePost = fSharePost;

/* ─── Submit top-level comment ────────────────────────────────── */
async function fSubmitComment(postId) {
  const input = document.getElementById('fcmt-input-' + postId);
  if (!input) return;
  const content = input.value.trim();
  if (!content) { if (typeof showToast === 'function') showToast('Write something first', 'error'); return; }
  input.disabled = true;
  try {
    await _fApi('/api/forum/posts/' + postId + '/comments', {
      method: 'POST',
      body: JSON.stringify({ content })
    });
    input.value = '';
    const list = document.getElementById('fcmtlist-' + postId);
    if (list) { list.dataset.loaded = ''; await fLoadComments(postId); }
    // bump comment count badge
    const post = document.querySelector('[data-post-id="'+postId+'"] .f-cmt-count');
    if (post) post.textContent = parseInt(post.textContent || 0) + 1;
    if (typeof showToast === 'function') showToast('Comment added!', 'success');
  } catch(e) {
    console.error('fSubmitComment:', e);
    if (typeof showToast === 'function') showToast('Failed to post comment', 'error');
  } finally {
    input.disabled = false;
  }
}
window.fSubmitComment = fSubmitComment;

/* ─── Reply form show/hide ────────────────────────────────────── */
function fShowReplyForm(commentId) {
  const form  = document.getElementById('freply-' + commentId);
  if (!form) return;
  form.style.display = 'flex';
  const inp = document.getElementById('freply-input-' + commentId);
  if (inp) inp.focus();
}
function fHideReplyForm(commentId) {
  const form = document.getElementById('freply-' + commentId);
  if (form) form.style.display = 'none';
  const inp = document.getElementById('freply-input-' + commentId);
  if (inp) inp.value = '';
}
window.fShowReplyForm = fShowReplyForm;
window.fHideReplyForm = fHideReplyForm;

/* ─── Submit reply ────────────────────────────────────────────── */
async function fSubmitReply(commentId, postId) {
  const input = document.getElementById('freply-input-' + commentId);
  if (!input) return;
  const content = input.value.trim();
  if (!content) { if (typeof showToast === 'function') showToast('Write something first', 'error'); return; }
  input.disabled = true;
  try {
    await _fApi('/api/forum/posts/' + postId + '/comments', {
      method: 'POST',
      body: JSON.stringify({ content, parentCommentId: commentId })
    });
    fHideReplyForm(commentId);
    const list = document.getElementById('fcmtlist-' + postId);
    if (list) { list.dataset.loaded = ''; await fLoadComments(postId); }
    if (typeof showToast === 'function') showToast('Reply added!', 'success');
  } catch(e) {
    console.error('fSubmitReply:', e);
    if (typeof showToast === 'function') showToast('Failed to post reply', 'error');
  } finally {
    input.disabled = false;
  }
}
window.fSubmitReply = fSubmitReply;

/* ─── Delete post ─────────────────────────────────────────────── */
async function fDeletePost(postId) {
  if (!confirm('Delete this post?')) return;
  try {
    await _fApi('/api/forum/posts/' + postId, { method: 'DELETE' });
    if (typeof showToast === 'function') showToast('Post deleted', 'success');
    loadForumPosts();
  } catch(e) {
    console.error('fDeletePost:', e);
    if (typeof showToast === 'function') showToast('Failed to delete post', 'error');
  }
}
window.fDeletePost = fDeletePost;
// backward-compat alias used by older inline buttons
window.deleteForumPost = fDeletePost;

/* ─── Delete comment ──────────────────────────────────────────── */
async function fDeleteComment(commentId, postId) {
  if (!confirm('Delete this comment?')) return;
  try {
    await _fApi('/api/forum/comments/' + commentId, { method: 'DELETE' });
    if (typeof showToast === 'function') showToast('Comment deleted', 'success');
    const list = document.getElementById('fcmtlist-' + postId);
    if (list) { list.dataset.loaded = ''; await fLoadComments(postId); }
    const cnt = document.querySelector('[data-post-id="'+postId+'"] .f-cmt-count');
    if (cnt) cnt.textContent = Math.max(0, parseInt(cnt.textContent || 1) - 1);
  } catch(e) {
    console.error('fDeleteComment:', e);
    if (typeof showToast === 'function') showToast('Failed to delete comment', 'error');
  }
}
window.fDeleteComment = fDeleteComment;

/* ─── New Post Modal ──────────────────────────────────────────── */
function openNewPostModal() {
  const t = document.getElementById('postTitle');
  const c = document.getElementById('postContent');
  const b = document.getElementById('postBannerData');
  const p = document.getElementById('postBannerPreview');
  const i = document.getElementById('postBannerInput');
  if (t) t.value = '';
  if (c) c.value = '';
  if (b) b.value = '';
  if (p) p.style.display = 'none';
  if (i) i.value = '';
  const m = document.getElementById('newPostModal');
  if (m) m.style.display = 'flex';
}
function closeNewPostModal() {
  const m = document.getElementById('newPostModal');
  if (m) m.style.display = 'none';
}
function previewPostBanner(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    const img  = document.getElementById('postBannerImg');
    const prev = document.getElementById('postBannerPreview');
    const data = document.getElementById('postBannerData');
    if (img)  img.src = ev.target.result;
    if (prev) prev.style.display = 'block';
    if (data) data.value = ev.target.result;
  };
  reader.readAsDataURL(file);
}
function removePostBanner() {
  const b = document.getElementById('postBannerData');
  const p = document.getElementById('postBannerPreview');
  const i = document.getElementById('postBannerInput');
  if (b) b.value = '';
  if (p) p.style.display = 'none';
  if (i) i.value = '';
}
async function submitForumPost() {
  const title  = (document.getElementById('postTitle')  || {}).value?.trim();
  const content= (document.getElementById('postContent')|| {}).value?.trim();
  const banner = (document.getElementById('postBannerData')|| {}).value || '';
  const btn    = document.getElementById('submitPostBtn');
  if (!title) { if (typeof showToast === 'function') showToast('Enter a title', 'error'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
  try {
    await _fApi('/api/forum/posts', {
      method: 'POST',
      body: JSON.stringify({ title, content, bannerImage: banner })
    });
    if (typeof showToast === 'function') showToast('Post created!', 'success');
    closeNewPostModal();
    loadForumPosts();
  } catch(e) {
    console.error('submitForumPost:', e);
    if (typeof showToast === 'function') showToast('Failed to create post', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Post'; }
  }
}
window.openNewPostModal  = openNewPostModal;
window.closeNewPostModal = closeNewPostModal;
window.previewPostBanner = previewPostBanner;
window.removePostBanner  = removePostBanner;
window.submitForumPost   = submitForumPost;
